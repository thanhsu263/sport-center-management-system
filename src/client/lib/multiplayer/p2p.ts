/**
 * Full-mesh WebRTC rooms: one RTCPeerConnection per remote peer, signaled
 * through /api/rtc (see signaling.server.ts), game data flowing directly
 * browser-to-browser afterwards. Client-authoritative by construction — see
 * the multiplayer-p2p skill for when NOT to use this.
 *
 * Negotiation follows the "perfect negotiation" pattern: on a glare (both
 * sides offering at once) the polite peer — the lexicographically smaller id —
 * rolls back and accepts, so pairs converge without wedging.
 */

export type SignalKind = "offer" | "answer" | "ice";

/**
 * Wire contract between this client and the signaling relay the app provides
 * at /api/rtc (see the multiplayer-p2p skill for a reference implementation).
 * The client only needs these shapes — the relay's storage is the app's choice.
 */
export interface PeerRow {
  id: string;
  name: string;
}
export interface SignalRow {
  id: number;
  from: string;
  kind: SignalKind;
  payload: unknown;
}
export interface RtcPollResponse {
  peers: PeerRow[];
  signals: SignalRow[];
}

export interface PeerInfo {
  id: string;
  name: string;
  connectionState: RTCPeerConnectionState;
  /** Selected local ICE candidate type: host | srflx | prflx | relay. */
  candidateType: string | null;
  /** Data-channel ping RTT (ms), measured every 2s once connected. */
  rttMs: number | null;
}

export interface P2PRoomOptions {
  room: string;
  selfId: string;
  name?: string;
  /** Defaults to VITE_STUN_URLS (comma-separated) or Google public STUN. */
  iceServers?: RTCIceServer[];
  onPeersChanged?: (peers: PeerInfo[]) => void;
  /** Fires for both the unreliable "state" and reliable "reliable" channels. */
  onMessage?: (from: string, data: unknown, channel: "state" | "reliable") => void;
  /** Fires once, on the first successful signaling poll (registration). */
  onConnected?: () => void;
  /**
   * Bearer token for the relay, read fresh on each call.
   *
   * A callback and not a value: a room outlives a token refresh, and `close()`
   * fires its leave during teardown, by which point anything captured at
   * construction may be stale. Omit it when the relay needs no auth.
   */
  getAuthToken?: () => string | null;
  /**
   * The relay refused this session (401/403). The room has stopped — direct
   * connections are not going to happen, so the app should say so rather than
   * leave the user looking at a relay badge and guessing.
   */
  onAuthError?: (status: number) => void;
}

/**
 * The relay rejected who we are, as opposed to being briefly unreachable.
 *
 * Worth its own type because the two want opposite handling: a transient
 * failure should be retried forever, and this should stop the room. Treating
 * them alike is what hid a signaling route that answered 401 to every single
 * call — the poll loop swallowed it and retried every 400ms, so the only
 * symptom was chat quietly never leaving the server relay.
 */
class SignalingAuthError extends Error {
  /**
   * Làm gì: Khởi tạo đối tượng lỗi khi server signaling từ chối quyền truy cập của phiên kết nối.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm pollOnce)
   * @param status Mã trạng thái HTTP (401 hoặc 403) trả về từ server signaling
   */
  constructor(readonly status: number) {
    super(`signaling refused the session: ${status}`);
    this.name = "SignalingAuthError";
  }
}

interface PeerSlot {
  pc: RTCPeerConnection;
  state?: RTCDataChannel;
  reliable?: RTCDataChannel;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** ICE candidates that arrived before the remote description (buffered). */
  pendingCandidates: RTCIceCandidateInit[];
  /** Last time this pair made observable progress toward connected. */
  lastProgressAt: number;
  /** Watchdog recreations (dialer) / stall windows (receiver) so far. */
  recoveryAttempts: number;
  /** Gave up after MAX_RECOVERY_ATTEMPTS — excluded from fast-poll pressure. */
  terminal?: boolean;
  /** One-shot: pc was already recreated to absorb a failing remote offer. */
  recreatedForOffer?: boolean;
  info: PeerInfo;
  pingSentAt?: number;
}

// Chu kỳ thăm dò nhanh (400ms): dùng khi có peer đang kết nối hoặc lỗi để trao đổi SDP/ICE nhanh nhất
const FAST_POLL_MS = 400;
// Chu kỳ thăm dò chậm (2000ms): dùng khi tất cả peer đã ổn định nhằm tiết kiệm tài nguyên mạng và server
const IDLE_POLL_MS = 2000;
// Tần suất gửi gói tin ping (2000ms): dùng để đo RTT (Round-Trip Time) và kiểm tra data channel còn sống
const PING_INTERVAL_MS = 2000;
// Thời gian tối đa (10 giây) không có tiến triển kết nối trước khi bị coi là bị treo và kích hoạt phục hồi
const STALL_MS = 10_000;
// Số lần thử phục hồi tối đa: sau 3 lần sẽ đánh dấu terminal (bỏ cuộc vì thường do NAT hoặc firewall chặn)
const MAX_RECOVERY_ATTEMPTS = 3;
// Khoảng thời gian chờ (ms) thử lại khi gửi tín hiệu signaling (POST /api/rtc) gặp sự cố mạng tạm thời
const SIGNAL_RETRY_DELAYS_MS = [250, 750];

/**
 * Làm gì: Cung cấp danh sách cấu hình máy chủ STUN mặc định để tìm địa chỉ IP công khai cho kết nối WebRTC.
 * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm connectTo, recreatePeer)
 * @returns Mảng cấu hình RTCIceServer chứa các URL máy chủ STUN
 */
export function defaultIceServers(): RTCIceServer[] {
  // Bước 1: Đọc danh sách STUN URL từ biến môi trường VITE_STUN_URLS và lọc các URL hợp lệ
  const urls = (import.meta.env.VITE_STUN_URLS as string | undefined)
    ?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  // Two independent providers: ICE queries all of them in parallel during
  // gathering, so either one being unreachable costs nothing.
  // Bước 2: Trả về STUN URL cấu hình hoặc dự phòng về hai nhà cung cấp độc lập (Google và Cloudflare)
  return [
    {
      urls: urls?.length ? urls : ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"],
    },
  ];
}

/**
 * Làm gì: Quản lý phòng mạng ngang hàng (P2P full-mesh) qua WebRTC, hỗ trợ trao đổi tín hiệu qua server relay /api/rtc và giải quyết xung đột đàm phán bằng Perfect Negotiation.
 * Được gọi ở: src/routes/chat.tsx (Chat component), src/client/lib/multiplayer/p2p.test.ts (test runner)
 */
export class P2PRoom {
  private readonly opts: P2PRoomOptions;
  private readonly peers = new Map<string, PeerSlot>();
  /** Per-remote-peer signal delivery chains (order-preserving). */
  private readonly signalQueues = new Map<string, Promise<void>>();
  private cursor = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private everPolled = false;
  private lastPeersFingerprint = "";

  /**
   * Làm gì: Khởi tạo một phiên phòng P2P với cấu hình phòng, định danh cá nhân và các hàm phản hồi sự kiện.
   * Được gọi ở: src/routes/chat.tsx (Chat component), src/client/lib/multiplayer/p2p.test.ts (test runner)
   * @param opts Đối tượng P2PRoomOptions chứa cấu hình phòng, selfId, name, getAuthToken và các callbacks
   */
  constructor(opts: P2PRoomOptions) {
    this.opts = opts;
  }

  /**
   * The first poll IS the join: it registers this peer and returns the
   * roster. A failed first poll (cold DB, offline tab) must not strand the
   * room: the loop and timers start regardless and the next poll retries.
   */
  async join(): Promise<void> {
    // Bước 1: Thực hiện lượt thăm dò đầu tiên để đăng ký bản thân vào danh sách phòng (roster)
    try {
      await this.pollOnce();
    } catch (e) {
      // First poll can fail transiently; the scheduled loop below retries.
      // Unless we were refused, in which case there is nothing to start.
      if (this.failIfRefused(e)) return;
    }
    // Bước 2: Kiểm tra nếu phòng đã bị đóng trong lúc chờ đợi thì dừng ngay
    if (this.closed) return;
    // Bước 3: Lên lịch thăm dò định kỳ (nhanh 400ms nếu đang kết nối, chậm 2000ms nếu đã ổn định)
    this.schedulePoll(this.anyPairConnecting() ? FAST_POLL_MS : IDLE_POLL_MS);
    // Bước 4: Thiết lập bộ đếm thời gian gửi ping đo độ trễ và chạy watchdog giám sát kết nối bị treo
    this.pingTimer = setInterval(() => {
      this.pingAll();
      this.watchdog();
    }, PING_INTERVAL_MS);
  }

  /**
   * Làm gì: Đóng toàn bộ kết nối WebRTC trong phòng, hủy các bộ đếm thời gian (poll/ping), giải phóng tài nguyên và gửi thông báo rời phòng tới server relay.
   * Được gọi ở: src/routes/chat.tsx (cleanup trong useEffect), src/client/lib/multiplayer/p2p.ts (hàm failIfRefused), src/client/lib/multiplayer/p2p.test.ts (test runner)
   */
  close(): void {
    // Bước 1: Đánh dấu phòng đã đóng và hủy các timer đang chạy để tránh rò rỉ tài nguyên
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    // Bước 2: Đóng toàn bộ các RTCPeerConnection hiện có và xóa danh sách peer cục bộ
    for (const slot of this.peers.values()) slot.pc.close();
    this.peers.clear();
    // Leaving the roster is the teardown broadcast: everyone's next poll
    // drops this peer and closes their side of the pair.
    // Bước 3: Gửi request 'leave' lên server bằng keepalive để báo cho các peer khác xóa mình khỏi danh sách kể cả khi tab đóng
    void fetch("/api/rtc", {
      method: "POST",
      headers: this.signalHeaders(true),
      body: JSON.stringify({ op: "leave", room: this.opts.room, peer: this.opts.selfId }),
      keepalive: true,
    }).catch(() => {});
  }

  /** Send on the unreliable game-state channel (drops stale packets). */
  broadcast(data: unknown): void {
    // Bước 1: Chuẩn hóa dữ liệu theo định dạng gói tin mạng (t: "d" nghĩa là data)
    const wire = JSON.stringify({ t: "d", d: data });
    // Bước 2: Duyệt qua từng peer và gửi qua data channel 'state' (kênh UDP không đảm bảo thứ tự, tối ưu độ trễ)
    for (const slot of this.peers.values()) {
      if (slot.state?.readyState === "open") slot.state.send(wire);
    }
  }

  /** Send reliably (ordered) to one peer, or to all when peerId is omitted. */
  send(data: unknown, peerId?: string): void {
    // Bước 1: Đóng gói dữ liệu tin nhắn thành chuỗi JSON
    const wire = JSON.stringify({ t: "d", d: data });
    // Bước 2: Xác định danh sách nhận: gửi đích danh cho 1 peer hoặc gửi tới toàn bộ peer
    const targets = peerId ? [this.peers.get(peerId)] : [...this.peers.values()];
    // Bước 3: Gửi qua kênh 'reliable' (kênh truyền SCTP đảm bảo đến nơi và đúng thứ tự)
    for (const slot of targets) {
      if (slot?.reliable?.readyState === "open") slot.reliable.send(wire);
    }
  }

  /**
   * Làm gì: Lấy bản sao danh sách thông tin hiện tại của tất cả các peer trong phòng (trạng thái kết nối, candidate type, RTT).
   * Được gọi ở: Các component UI hoặc consumer sử dụng P2PRoom để hiển thị danh sách thành viên
   * @returns Mảng đối tượng PeerInfo chứa thông tin chi tiết của từng peer
   */
  peerList(): PeerInfo[] {
    // Tạo bản sao thông tin từng peer để tránh bên ngoài làm thay đổi trạng thái nội bộ
    return [...this.peers.values()].map((s) => ({ ...s.info }));
  }

  // ── signaling loop ─────────────────────────────────────────────────────────

  /**
   * Làm gì: Lên lịch cho lần thăm dò (poll) tiếp theo tới server signaling sau một khoảng thời gian chờ nhất định.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm join, poll, connectTo, recreatePeer)
   * @param delay Thời gian chờ tính bằng mili-giây (ms) trước khi thực hiện poll
   */
  private schedulePoll(delay: number): void {
    // Bước 1: Không lên lịch nếu phòng đã bị đóng
    if (this.closed) return;
    // Bước 2: Hủy timer cũ trước khi đặt timer mới để tránh chạy trùng lặp nhiều vòng poll
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  /**
   * Làm gì: Kiểm tra xem có peer nào trong phòng đang trong quá trình kết nối (chưa đạt trạng thái 'connected' và chưa bị coi là 'terminal') hay không.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm join, poll để quyết định dùng FAST_POLL_MS hay IDLE_POLL_MS)
   * @returns true nếu còn ít nhất một peer đang kết nối, false nếu tất cả đã kết nối hoặc đã bỏ cuộc
   */
  private anyPairConnecting(): boolean {
    // Duyệt qua tất cả peer để kiểm tra trạng thái kết nối WebRTC
    for (const s of this.peers.values()) {
      // Terminal pairs (NAT-blocked after all recovery attempts) must not pin
      // the session at the 400ms fast-poll rate.
      if (s.terminal) continue;
      if (s.info.connectionState !== "connected") return true;
    }
    return false;
  }

  /**
   * Headers for one signaling call.
   *
   * The token never travels in the query string: `/api/rtc?...` ends up in
   * server logs and browser history, which is no place for a session.
   */
  private signalHeaders(json: boolean): Record<string, string> {
    // Bước 1: Thêm Content-Type JSON nếu request có body dữ liệu
    const headers: Record<string, string> = json ? { "content-type": "application/json" } : {};
    // Bước 2: Đọc token xác thực mới nhất và gán vào Authorization header thay vì URL query để đảm bảo bảo mật
    const token = this.opts.getAuthToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Làm gì: Thực hiện một lượt HTTP GET tới /api/rtc để cập nhật danh sách thành viên trong phòng (roster) và nhận các tín hiệu WebRTC mới phát sinh kể từ cursor trước đó.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm join, poll)
   * @throws SignalingAuthError Khi server từ chối xác thực (mã lỗi 401 hoặc 403)
   * @throws Error Khi request HTTP thất bại với mã lỗi khác
   */
  private async pollOnce(): Promise<void> {
    // Bước 1: Chuẩn bị tham số truy vấn gồm mã phòng, ID bản thân, tên hiển thị và vị trí cursor tín hiệu
    const params = new URLSearchParams({
      room: this.opts.room,
      peer: this.opts.selfId,
      name: this.opts.name ?? "",
      since: String(this.cursor),
    });
    // Bước 2: Gửi request GET tới endpoint signaling /api/rtc
    const res = await fetch(`/api/rtc?${params}`, { headers: this.signalHeaders(false) });
    if (this.closed) return;
    // Ném lỗi xác thực đặc biệt để dừng hẳn phòng thay vì thử lại vô hạn
    if (res.status === 401 || res.status === 403) throw new SignalingAuthError(res.status);
    if (!res.ok) throw new Error(`signaling poll failed: ${res.status}`);
    const body = (await res.json()) as RtcPollResponse;
    if (this.closed) return;
    // Bước 3: Kích hoạt callback onConnected trong lần thăm dò thành công đầu tiên
    if (!this.everPolled) {
      this.everPolled = true;
      this.opts.onConnected?.();
    }
    // Bước 4: Đồng bộ danh sách peer mới từ server với danh sách kết nối hiện tại
    this.reconcileRoster(body.peers);
    // Bước 5: Lần lượt xử lý các tín hiệu nhận được và cập nhật con trỏ cursor để không nhận lại tín hiệu cũ
    const roster = new Set(body.peers.map((p) => p.id));
    for (const sig of body.signals) {
      this.cursor = Math.max(this.cursor, sig.id);
      await this.onSignal(sig.from, sig.kind, sig.payload, roster);
      if (this.closed) return;
    }
  }

  /**
   * Làm gì: Thực hiện vòng lặp thăm dò tín hiệu định kỳ; gọi pollOnce, bắt và xử lý lỗi xác thực, sau đó tự lên lịch cho lần thăm dò tiếp theo.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm schedulePoll qua setTimeout)
   */
  private async poll(): Promise<void> {
    if (this.closed) return;
    // Bước 1: Gọi pollOnce để nhận tín hiệu và cập nhật danh sách peer
    try {
      await this.pollOnce();
    } catch (e) {
      // Transient poll failures are expected (tab sleep, deploy roll); retry.
      // A refusal is not one of those — every later poll would be refused the
      // same way, so stop and tell the app instead of retrying twice a second
      // for as long as the tab is open.
      // Nếu server từ chối quyền (401/403) thì failIfRefused sẽ đóng phòng và dừng hẳn loop
      if (this.failIfRefused(e)) return;
    }
    // Bước 2: Lên lịch cho chu kỳ thăm dò tiếp theo dựa vào trạng thái kết nối của các peer
    this.schedulePoll(this.anyPairConnecting() ? FAST_POLL_MS : IDLE_POLL_MS);
  }

  /**
   * Shut the room down when the relay refused us; `false` for anything else,
   * which callers then treat as transient.
   */
  private failIfRefused(e: unknown): boolean {
    // Bước 1: Kiểm tra xem lỗi có phải do server signaling từ chối quyền truy cập (SignalingAuthError) hay không
    if (!(e instanceof SignalingAuthError)) return false;
    console.warn(`[p2p] ${e.message} — no direct connections for this room`);
    const notify = this.opts.onAuthError;
    const status = e.status;
    // Bước 2: Đóng phòng P2P và kích hoạt callback onAuthError để thông báo cho ứng dụng
    this.close();
    notify?.(status);
    return true;
  }

  /**
   * Làm gì: Đối soát danh sách peer nhận từ server signaling với các kết nối hiện tại; khởi tạo kết nối tới peer mới, cập nhật tên hoặc dọn dẹp các peer đã rời phòng.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm pollOnce)
   * @param peers Danh sách các peer đang hoạt động trong phòng trả về từ server
   */
  private reconcileRoster(peers: { id: string; name: string }[]): void {
    // Bước 1: Tạo tập hợp các peer ID đang còn hoạt động để tra cứu nhanh
    const alive = new Set(peers.map((p) => p.id));
    // Bước 2: Xử lý peer mới hoặc cập nhật thông tin peer hiện có
    for (const p of peers) {
      if (p.id === this.opts.selfId) continue;
      const existing = this.peers.get(p.id);
      if (existing) {
        existing.info.name = p.name;
      } else {
        // Exactly one side dials each pair; the other waits for the offer.
        // Quy tắc so sánh selfId > p.id để chỉ duy nhất một bên chủ động khởi tạo (initiator) gửi offer, tránh xung đột
        this.connectTo(p.id, p.name, this.opts.selfId > p.id);
      }
    }
    // Bước 3: Đóng kết nối và xóa các peer không còn xuất hiện trong danh sách từ server
    for (const [id, slot] of this.peers) {
      if (!alive.has(id)) {
        slot.pc.close();
        this.peers.delete(id);
      }
    }
    // Bước 4: Phát sự kiện cập nhật danh sách peer ra ngoài UI nếu có thay đổi
    this.emitPeers();
  }

  // ── per-pair connection ────────────────────────────────────────────────────

  /**
   * Làm gì: Khởi tạo một đối tượng RTCPeerConnection mới và tạo slot quản lý kết nối ngang hàng với một remote peer cụ thể.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm reconcileRoster, onSignal)
   * @param peerId ID định danh của remote peer cần kết nối
   * @param name Tên hiển thị của remote peer
   * @param initiator true nếu mình là bên chủ động khởi tạo gửi offer, false nếu chờ nhận offer
   * @returns Đối tượng PeerSlot quản lý kết nối, hoặc null nếu phòng đã đóng
   */
  private connectTo(peerId: string, name: string, initiator: boolean): PeerSlot | null {
    // Bước 1: Kiểm tra nếu phòng đã đóng thì không khởi tạo kết nối mới
    if (this.closed) return null;
    // Bước 2: Tạo RTCPeerConnection với danh sách máy chủ ICE STUN
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers ?? defaultIceServers(),
    });
    // Bước 3: Khởi tạo đối tượng PeerSlot lưu giữ trạng thái đàm phán và các thông tin đo lường
    const slot: PeerSlot = {
      pc,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      lastProgressAt: Date.now(),
      recoveryAttempts: 0,
      info: {
        id: peerId,
        name,
        connectionState: pc.connectionState,
        candidateType: null,
        rttMs: null,
      },
    };
    // Bước 4: Lưu slot kết nối của peer vào Map peers để quản lý tập trung
    this.peers.set(peerId, slot);

    // Bước 5: Lắng nghe sự kiện tìm thấy ICE candidate và gửi cho remote peer qua signaling relay
    pc.onicecandidate = (e) => {
      if (e.candidate) void this.sendSignal(peerId, "ice", e.candidate.toJSON());
    };
    // Bước 6: Theo dõi thay đổi trạng thái kết nối WebRTC để cập nhật thông tin và xử lý sự cố mạng
    pc.onconnectionstatechange = () => {
      slot.info.connectionState = pc.connectionState;
      if (pc.connectionState === "connecting" || pc.connectionState === "connected") {
        slot.lastProgressAt = Date.now();
      }
      if (pc.connectionState === "connected") {
        slot.recoveryAttempts = 0;
        slot.terminal = false;
        void this.readCandidateType(slot);
      }
      this.emitPeers();
      if (pc.connectionState === "failed") {
        // Khi kết nối thất bại (failed), khởi động lại ICE để tạo offer mới mà không làm treo phiên kết nối
        // Refires negotiationneeded → a fresh offer through signaling, so a
        // lost offer or dead path cannot wedge the pair (glare-safe).
        pc.restartIce();
      }
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        // Tăng tốc độ thăm dò lên FAST_POLL_MS (400ms) để nhanh chóng trao đổi lại tín hiệu phục hồi kết nối
        this.schedulePoll(FAST_POLL_MS);
      }
    };
    // Bước 7: Xử lý đàm phán lại (onnegotiationneeded) khi cần thiết lập kết nối hoặc tạo DataChannel
    pc.onnegotiationneeded = async () => {
      try {
        slot.makingOffer = true;
        await pc.setLocalDescription();
        await this.sendSignal(peerId, "offer", pc.localDescription!.toJSON());
      } catch {
        // A failed offer is retried on the next negotiationneeded.
      } finally {
        slot.makingOffer = false;
      }
    };
    // Bước 8: Lắng nghe kênh DataChannel từ remote peer (khi đóng vai trò nhận kết nối - receiver)
    pc.ondatachannel = (e) => this.attachChannel(slot, e.channel);

    // Bước 9: Nếu là bên chủ động (initiator), tạo 2 DataChannel ("state" gửi nhanh và "reliable" gửi tin cậy)
    if (initiator) {
      // Creating the channels triggers negotiationneeded → the offer.
      this.attachChannel(
        slot,
        pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 }),
      );
      this.attachChannel(slot, pc.createDataChannel("reliable", { ordered: true }));
    }
    // Bước 10: Trả về đối tượng PeerSlot hoàn chỉnh
    return slot;
  }

  /**
   * Làm gì: Gắn kết và cài đặt các trình lắng nghe sự kiện (onopen, onmessage) cho RTCDataChannel ("state" hoặc "reliable").
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm connectTo)
   * @param slot Đối tượng PeerSlot quản lý kết nối với remote peer
   * @param channel Kênh dữ liệu RTCDataChannel cần gắn kết và xử lý dữ liệu
   * @returns Không trả về giá trị (void)
   */
  private attachChannel(slot: PeerSlot, channel: RTCDataChannel): void {
    // Bước 1: Lưu kênh vào slot theo nhãn ("state" truyền trạng thái tức thời, "reliable" truyền tin nhắn tin cậy)
    if (channel.label === "state") slot.state = channel;
    else slot.reliable = channel;
    // Bước 2: Cập nhật mốc thời gian hoạt động khi kênh mở thành công để tránh watchdog hiểu nhầm bị treo
    channel.onopen = () => {
      slot.lastProgressAt = Date.now();
    };
    // Bước 3: Lắng nghe và xử lý các gói tin nhận được (heartbeat ping/pong hoặc dữ liệu ứng dụng)
    channel.onmessage = (e) => {
      let msg: { t: string; d?: unknown };
      try {
        msg = JSON.parse(e.data as string) as { t: string; d?: unknown };
      } catch {
        return;
      }
      // Nếu nhận gói tin ping từ peer, lập tức gửi lại phản hồi pong qua kênh state
      if (msg.t === "ping") {
        if (slot.state?.readyState === "open") {
          slot.state.send(JSON.stringify({ t: "pong" }));
        }
      } else if (msg.t === "pong") {
        // Nếu nhận gói tin pong, tính toán độ trễ khứ hồi RTT (Round-Trip Time) bằng ms và cập nhật danh sách peer
        if (slot.pingSentAt) {
          slot.info.rttMs = Math.round(performance.now() - slot.pingSentAt);
          slot.pingSentAt = undefined;
          this.emitPeers();
        }
      } else {
        // Gói tin dữ liệu thông thường: chuyển tiếp tới callback onMessage của ứng dụng
        this.opts.onMessage?.(
          slot.info.id,
          msg.d,
          channel.label === "state" ? "state" : "reliable",
        );
      }
    };
  }

  /** Apply buffered ICE candidates once a remote description is in place. */
  private async flushPendingCandidates(slot: PeerSlot): Promise<void> {
    // Bước 1: Lần lượt lấy các ICE candidate đang xếp hàng chờ trong pendingCandidates
    while (slot.pendingCandidates.length > 0) {
      const candidate = slot.pendingCandidates.shift()!;
      // Bước 2: Bổ sung ICE candidate vào RTCPeerConnection sau khi đã có Remote Description
      try {
        await slot.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!slot.ignoreOffer) console.warn("[p2p] addIceCandidate failed:", err);
      }
      if (this.closed) return;
    }
  }

  /**
   * Làm gì: Xử lý tín hiệu WebRTC (offer, answer, ice) nhận được từ remote peer theo cơ chế Perfect Negotiation.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm pollOnce)
   * @param from ID của remote peer gửi tín hiệu
   * @param kind Loại tín hiệu signaling ("offer", "answer" hoặc "ice")
   * @param payload Dữ liệu SDP (phiên kết nối) hoặc thông tin ICE candidate
   * @param roster Tập hợp ID của các peer đang có mặt hợp lệ trong phòng
   * @returns Promise<void> hoàn thành khi xử lý xong tín hiệu
   */
  private async onSignal(
    from: string,
    kind: SignalKind,
    payload: unknown,
    roster: Set<string>,
  ): Promise<void> {
    // Bước 1: Kiểm tra phòng còn hoạt động hay không trước khi xử lý tín hiệu
    if (this.closed) return;
    // Bước 2: Tìm kiếm hoặc khởi tạo slot kết nối tương ứng với remote peer gửi tín hiệu
    let slot = this.peers.get(from);
    if (!slot) {
      // New peers dial us in the same poll that adds them to the roster.
      // Signals outlive membership, so drop senders the roster doesn't vouch for.
      if (!roster.has(from)) return;
      const created = this.connectTo(from, "", false);
      if (!created) return;
      slot = created;
    }
    // Quy tắc Perfect Negotiation: bên có selfId nhỏ hơn là "polite" (nhường nhịn), sẽ rollback nếu xảy ra xung đột offer (glare)
    const polite = this.opts.selfId < from;

    try {
      // Bước 3: Xử lý tín hiệu SDP đàm phán phiên kết nối (offer hoặc answer)
      if (kind === "offer" || kind === "answer") {
        const description = payload as RTCSessionDescriptionInit;
        // Phát hiện xung đột (glare) khi cả hai bên cùng gửi offer đồng thời
        const collision =
          kind === "offer" && (slot.makingOffer || slot.pc.signalingState !== "stable");
        slot.ignoreOffer = !polite && collision;
        if (slot.ignoreOffer) return;
        // Áp dụng mô tả phiên từ xa (setRemoteDescription); phía polite sẽ tự động rollback nếu xung đột
        try {
          await slot.pc.setRemoteDescription(description); // implicit rollback when polite
        } catch (err) {
          // A pc resumed from suspend can be unable to take any new remote
          // offer (stale DTLS fingerprint). Rebuild the pair once and apply
          // the same offer to the fresh pc before giving up.
          // Phục hồi lỗi khi tab bị suspend làm mất dấu vân tay DTLS: đóng và tái tạo RTCPeerConnection mới một lần duy nhất
          if (kind !== "offer" || slot.recreatedForOffer) throw err;
          const attempts = slot.recoveryAttempts;
          const name = slot.info.name;
          slot.pc.close();
          this.peers.delete(from);
          const fresh = this.connectTo(from, name, false);
          if (!fresh) return;
          fresh.recoveryAttempts = attempts;
          fresh.recreatedForOffer = true;
          slot = fresh;
          await slot.pc.setRemoteDescription(description);
        }
        if (this.closed) return;
        // Giải phóng các ICE candidate đã tích lũy trong hàng đợi sau khi setRemoteDescription thành công
        await this.flushPendingCandidates(slot);
        if (this.closed) return;
        // Nếu nhận được offer, tạo SDP answer cục bộ và gửi phản hồi lại cho bên gửi
        if (kind === "offer") {
          await slot.pc.setLocalDescription();
          if (this.closed) return;
          await this.sendSignal(from, "answer", slot.pc.localDescription!.toJSON());
        }
      } else if (kind === "ice") {
        // Bước 4: Xử lý tín hiệu ICE candidate để thiết lập đường truyền trực tiếp giữa hai trình duyệt
        const candidate = payload as RTCIceCandidateInit;
        // Nếu candidate đến trước Remote Description, lưu tạm vào pendingCandidates để xử lý sau
        if (!slot.pc.remoteDescription) {
          // Candidate raced ahead of its SDP — hold it until the description
          // lands (flushed after every successful setRemoteDescription).
          slot.pendingCandidates.push(candidate);
          return;
        }
        // Thêm ICE candidate vào đối tượng RTCPeerConnection
        try {
          await slot.pc.addIceCandidate(candidate);
        } catch (err) {
          // The enclosing catch would swallow a rethrow; log the real signal.
          if (!slot.ignoreOffer) console.warn("[p2p] addIceCandidate failed:", err);
        }
      }
    } catch {
      // Negotiation errors resolve on the next offer cycle; state is visible
      // to the app via connectionState.
    }
  }

  /**
   * Signals are serialized per remote peer (a candidate must never overtake
   * its SDP into the DB) and retried on failure with short backoff.
   */
  private sendSignal(to: string, kind: SignalKind, payload: unknown): Promise<void> {
    // Bước 1: Nối tiếp vào hàng đợi Promise của remote peer để đảm bảo thứ tự gửi (candidate không được vượt trước SDP)
    const prev = this.signalQueues.get(to) ?? Promise.resolve();
    const next = prev.then(() => this.postSignal(to, kind, payload));
    // Bước 2: Cập nhật hàng đợi và chặn nuốt lỗi (catch) để chuỗi gửi tiếp theo không bị gián đoạn
    this.signalQueues.set(
      to,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * Làm gì: Gửi tín hiệu signaling tới server relay qua HTTP POST (/api/rtc) với cơ chế tự động thử lại khi lỗi mạng.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm sendSignal)
   * @param to ID của remote peer nhận tín hiệu
   * @param kind Loại tín hiệu signaling ("offer", "answer" hoặc "ice")
   * @param payload Dữ liệu gói tin SDP hoặc ICE candidate
   * @returns Promise<void> hoàn thành khi gửi thành công hoặc đã thử lại hết số lần cho phép
   * @throws SignalingAuthError nếu server signaling từ chối quyền truy cập (mã HTTP 401 hoặc 403)
   */
  private async postSignal(to: string, kind: SignalKind, payload: unknown): Promise<void> {
    // Bước 1: Vòng lặp thử lại gửi tín hiệu qua HTTP POST tới endpoint /api/rtc
    for (let attempt = 0; ; attempt++) {
      if (this.closed) return;
      try {
        // Bước 2: Thực hiện gửi yêu cầu POST kèm token xác thực và dữ liệu tín hiệu signaling
        const res = await fetch("/api/rtc", {
          method: "POST",
          headers: this.signalHeaders(true),
          body: JSON.stringify({
            op: "signal",
            room: this.opts.room,
            from: this.opts.selfId,
            to,
            kind,
            payload,
          }),
        });
        if (res.ok) return;
        // Ném lỗi xác thực đặc biệt để dừng phòng ngay lập tức thay vì thử lại vô ích
        if (res.status === 401 || res.status === 403) throw new SignalingAuthError(res.status);
        throw new Error(`signal POST failed: ${res.status}`);
      } catch (err) {
        // Retrying a refusal just delays the same answer twice over.
        // Bước 3: Xử lý lỗi kết nối; dừng nếu bị từ chối quyền hoặc chờ theo SIGNAL_RETRY_DELAYS_MS rồi thử lại
        if (this.failIfRefused(err)) return;
        // Nếu đã vượt quá số lần thử lại ([250ms, 750ms]), từ bỏ và để cơ chế watchdog phục hồi sau
        if (attempt >= SIGNAL_RETRY_DELAYS_MS.length) {
          // Delivery gave up; the pair converges on the next offer cycle (or
          // the watchdog rebuilds it). Logged once so failures are visible.
          console.warn(`[p2p] signal ${kind} to ${to} failed after retries`, err);
          return;
        }
        await new Promise((r) => setTimeout(r, SIGNAL_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  // ── diagnostics + recovery ─────────────────────────────────────────────────

  /**
   * Làm gì: Gửi gói tin heartbeat ping định kỳ tới tất cả remote peer qua DataChannel ("state") để đo độ trễ RTT.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm join qua setInterval pingTimer)
   * @returns Không trả về giá trị (void)
   */
  private pingAll(): void {
    // Bước 1: Chuẩn bị gói tin heartbeat ping dạng JSON
    const wire = JSON.stringify({ t: "ping" });
    // Bước 2: Duyệt qua tất cả peer và chỉ gửi qua kênh state khi kênh đã mở ("open")
    for (const slot of this.peers.values()) {
      if (slot.state?.readyState !== "open") continue;
      // Nếu gói pong bị thất lạc quá 2 chu kỳ (4000ms), coi như đã hết hạn để cho phép gửi lượt ping mới
      const stale =
        slot.pingSentAt !== undefined && performance.now() - slot.pingSentAt > 2 * PING_INTERVAL_MS;
      if (slot.pingSentAt === undefined || stale) {
        // A lost pong must not freeze rttMs forever: expire and re-ping.
        // Bước 3: Ghi nhận thời điểm gửi ping và truyền gói tin qua DataChannel
        slot.pingSentAt = performance.now();
        slot.state.send(wire);
      }
    }
  }

  /**
   * Stuck-pair recovery, piggybacked on the ping interval. A pair that has
   * made no progress for STALL_MS gets rebuilt by the dialer with a FRESH
   * RTCPeerConnection (new DTLS identity — fixes the suspend/resume
   * fingerprint wedge). After MAX_RECOVERY_ATTEMPTS the pair is terminal:
   * visible to the app as its last connectionState, ignored by fast-poll.
   */
  private watchdog(): void {
    // Bước 1: Kiểm tra trạng thái phòng, nếu đã đóng thì dừng giám sát
    if (this.closed) return;
    const now = Date.now();
    // Bước 2: Duyệt qua từng peer để kiểm tra trạng thái thực tế và phát hiện kết nối bị treo
    for (const [peerId, slot] of this.peers) {
      // pc.close() and some suspend/resume wedges never fire
      // connectionstatechange — read the LIVE state so a silently-dead pc
      // still trips the stall timer instead of hiding behind a cached
      // "connected". Only live progress states refresh the stall clock.
      // Đọc trạng thái trực tiếp từ RTCPeerConnection vì sự kiện connectionstatechange có thể không kích hoạt khi suspend
      const live = slot.pc.connectionState;
      if (live !== slot.info.connectionState) {
        slot.info.connectionState = live;
        if (live === "connecting" || live === "connected") slot.lastProgressAt = now;
        this.emitPeers();
      }
      // Bỏ qua nếu peer đã đánh dấu terminal (hết số lần thử) hoặc đã kết nối thành công
      if (slot.terminal || live === "connected") continue;
      // Bỏ qua nếu thời gian không có tiến triển chưa vượt ngưỡng STALL_MS (10 giây)
      if (now - slot.lastProgressAt <= STALL_MS) continue;
      // Bước 3: Nếu vượt quá MAX_RECOVERY_ATTEMPTS (3 lần thử), đánh dấu terminal và ngừng thử kết nối
      if (slot.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        slot.terminal = true;
        this.emitPeers();
        continue;
      }
      // Bước 4: Tăng số lần thử phục hồi và đặt lại mốc thời gian tiến triển
      slot.recoveryAttempts += 1;
      slot.lastProgressAt = now; // re-arm the stall window
      // Bước 5: Nếu mình là dialer (selfId > peerId), hủy kết nối cũ và tạo lại RTCPeerConnection hoàn toàn mới
      if (this.opts.selfId > peerId) {
        // We are the dialer: rebuild the pair from scratch.
        const { name } = slot.info;
        const attempts = slot.recoveryAttempts;
        slot.pc.close();
        this.peers.delete(peerId);
        const fresh = this.connectTo(peerId, name, true);
        if (fresh) fresh.recoveryAttempts = attempts;
        // Kích hoạt thăm dò nhanh (FAST_POLL_MS = 400ms) để gửi offer mới ngay lập tức
        this.schedulePoll(FAST_POLL_MS);
      }
      // Receiver side: count the stall window and wait for the dialer's
      // fresh offer (onSignal absorbs it, recreating our pc if needed).
    }
  }

  /**
   * Làm gì: Đọc thống kê WebRTC (getStats) để trích xuất loại ICE candidate cục bộ đang được dùng (host, srflx hoặc relay).
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm connectTo khi trạng thái chuyển sang "connected")
   * @param slot Đối tượng PeerSlot của peer vừa kết nối thành công
   * @returns Promise<void> hoàn thành khi đọc và cập nhật xong candidateType
   */
  private async readCandidateType(slot: PeerSlot): Promise<void> {
    // relay = TURN (none configured by default); srflx/host = direct path.
    // Bước 1: Lấy bảng thống kê mạng từ RTCPeerConnection thông qua getStats()
    try {
      const stats = await slot.pc.getStats();
      let selected: RTCIceCandidatePairStats | undefined;
      // Bước 2: Tìm cặp ứng viên ICE đang được chỉ định sử dụng (nominated = true)
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
          selected = s as RTCIceCandidatePairStats;
        }
      });
      const localId = selected?.localCandidateId;
      // Bước 3: Lấy loại ứng viên (candidateType) của local candidate và cập nhật vào thông tin peer
      if (localId) {
        const local = stats.get(localId) as { candidateType?: string } | undefined;
        slot.info.candidateType = local?.candidateType ?? null;
        this.emitPeers();
      }
    } catch {
      // getStats is best-effort diagnostics only.
    }
  }

  /**
   * Làm gì: So sánh dấu vân tay (fingerprint) và phát danh sách peer mới qua callback onPeersChanged nếu có thay đổi.
   * Được gọi ở: src/client/lib/multiplayer/p2p.ts (hàm connectTo, attachChannel, watchdog, readCandidateType, reconcileRoster)
   * @returns Không trả về giá trị (void)
   */
  private emitPeers(): void {
    // Only notify when something observable actually changed — React state
    // setters otherwise re-render consumers on every poll/ping.
    // Bước 1: Tạo danh sách thông tin peer và chuỗi fingerprint đại diện cho trạng thái hiện tại
    const list = this.peerList();
    const fingerprint = JSON.stringify(
      list.map((p) => [p.id, p.name, p.connectionState, p.candidateType, p.rttMs]),
    );
    // Bước 2: So sánh với fingerprint trước đó, nếu không đổi thì bỏ qua để tránh React re-render dư thừa
    if (fingerprint === this.lastPeersFingerprint) return;
    // Bước 3: Lưu lại fingerprint mới và gọi callback onPeersChanged thông báo cho ứng dụng
    this.lastPeersFingerprint = fingerprint;
    this.opts.onPeersChanged?.(list);
  }
}
