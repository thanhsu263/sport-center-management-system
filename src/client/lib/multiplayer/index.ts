/**
 * File: src/client/lib/multiplayer/index.ts
 * Vai trò: Điểm xuất khẩu tập trung (barrel export) cho module mạng ngang hàng (WebRTC P2P multiplayer).
 * Vị trí trong app: Tái xuất class P2PRoom, hàm defaultIceServers và các kiểu dữ liệu signaling từ ./p2p; cung cấp API kết nối trực tiếp browser-to-browser cho tính năng chat (src/routes/chat.tsx) và tương tác thời gian thực mà không cần đi qua máy chủ sau khi bắt tay thành công.
 *
 * Làm gì: Tái xuất class P2PRoom (quản lý kết nối WebRTC full-mesh, kênh dữ liệu state và reliable) cùng hàm defaultIceServers (cấu hình danh sách máy chủ STUN mặc định).
 * Được gọi ở: src/routes/chat.tsx (khởi tạo phòng chat P2P giữa các người dùng) và src/client/lib/multiplayer/p2p.test.ts (kiểm thử kết nối WebRTC).
 */
export { P2PRoom, defaultIceServers } from "./p2p";
// Tái xuất các kiểu dữ liệu và interface định nghĩa thông tin peer, cấu hình phòng và bản tin signaling WebRTC
export type {
  PeerInfo,
  P2PRoomOptions,
  SignalKind,
  PeerRow,
  SignalRow,
  RtcPollResponse,
} from "./p2p";
