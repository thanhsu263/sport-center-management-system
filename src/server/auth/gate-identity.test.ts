/**
 * Mục đích file:
 * Kiểm thử đơn vị (unit test) cho module src/server/auth/gate-identity.server.ts.
 * Xác thực tính hợp lệ của token JWT (EdDSA / Ed25519) do Grok Gate cấp, kiểm tra hạn dùng (exp), audience, issuer,
 * cơ chế cache/xoay vòng khóa JWKS và logic trích xuất danh tính người dùng từ request headers.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong bộ kiểm thử tự động,
 * bảo đảm cơ chế xác thực danh tính người xem (viewer gate identity) luôn an toàn và fail-closed khi thiếu hoặc sai token.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { SignJWT, exportJWK, type JWK } from "jose";
import {
  gateIdentityEnabled,
  gateIdentityFromHeaders,
  gateIdentityUserInfo,
  gateKeyResolver,
  gateTokenAudience,
  sessionBoundToGateIdentity,
  verifyGateIdentityToken,
  type GateJwks,
} from "./gate-identity.server.ts";

// Cấu hình issuer và audience giả lập dùng chung cho các token kiểm thử của Grok Gate
const ISSUER = "https://gate.app-builder-testing.com";
const AUDIENCE = "app:proj-123";

type TestKey = { privateKey: KeyObject; jwk: JWK; kid: string };

/**
 * Làm gì: Sinh ngẫu nhiên một cặp khóa bất đối xứng Ed25519 để ký và xác thực token JWT giả lập trong môi trường test.
 * Được gọi ở: Nội bộ file src/server/auth/gate-identity.test.ts (trong các ca kiểm thử)
 * @param kid Định danh khóa (Key ID) gắn vào JWK và header của JWT
 * @returns {Promise<TestKey>} Đối tượng chứa privateKey, kid và JWK công khai
 */
async function makeKey(kid: string): Promise<TestKey> {
  // Bước 1: Sinh ngẫu nhiên cặp khóa bất đối xứng với thuật toán ed25519
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Bước 2: Xuất khóa công khai sang định dạng chuẩn JWK (JSON Web Key)
  const jwk = await exportJWK(publicKey);
  // Bước 3: Đóng gói privateKey để ký và JWK công khai kèm thuật toán EdDSA để xác thực
  return {
    privateKey,
    kid,
    jwk: { ...jwk, alg: "EdDSA", use: "sig", kid },
  };
}

type SignOptions = {
  issuer?: string;
  audience?: string;
  expiresIn?: number;
  issuedAt?: number;
  omitExp?: boolean;
};

/**
 * Làm gì: Tạo và ký số một chuỗi JWT giả lập bằng privateKey Ed25519 kèm các claims và tùy chọn hết hạn.
 * Được gọi ở: Nội bộ file src/server/auth/gate-identity.test.ts (tạo token kiểm thử)
 * @param key Cặp khóa test dùng để ký
 * @param claims Các payload claim tùy biến (sub, email, name, team_id...)
 * @param options Tùy chọn ghi đè issuer, audience, thời điểm phát hành (iat) và cờ bỏ qua exp
 * @returns {Promise<string>} Chuỗi JWT hoàn chỉnh đã được ký số
 */
async function signToken(
  key: TestKey,
  claims: Record<string, unknown>,
  options: SignOptions = {},
): Promise<string> {
  // Bước 1: Lấy timestamp Unix hiện tại tính theo giây làm mốc phát hành (iat)
  const now = Math.floor(Date.now() / 1000);
  // Bước 2: Khởi tạo JWT với thuật toán EdDSA, gắn header kid và thiết lập các claim iss, aud, iat
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(options.issuedAt ?? now);
  // Bước 3: Thiết lập hạn sống exp (mặc định 300s = 5 phút), trừ khi bật cờ omitExp để test lỗi thiếu exp
  if (!options.omitExp) {
    jwt.setExpirationTime((options.issuedAt ?? now) + (options.expiresIn ?? 300));
  }
  // Bước 4: Ký số bằng privateKey và trả về chuỗi JWT
  return jwt.sign(key.privateKey);
}

/**
 * Làm gì: Giả lập hàm fetch JWKS trả về danh sách khóa công khai cố định và đếm số lần gọi để kiểm tra cache.
 * Được gọi ở: Nội bộ file src/server/auth/gate-identity.test.ts (giả lập endpoint /__gate/identity-key)
 * @param keys Danh sách JWK công khai cần trả về khi fetch
 * @returns Đối tượng gồm hàm fetchImpl trả về danh sách khóa và hàm calls để đọc số lần gọi
 */
function staticJwks(keys: JWK[]): {
  fetchImpl: (url: string) => Promise<GateJwks | null>;
  calls: () => number;
} {
  // Biến đếm số lần gọi fetchImpl để kiểm tra tính năng cache
  let count = 0;
  return {
    fetchImpl: async () => {
      count += 1;
      return { keys };
    },
    calls: () => count,
  };
}

let urlCounter = 0;
/**
 * Làm gì: Sinh URL endpoint JWKS duy nhất cho từng test case để tránh dùng lại cache trong jwksCache giữa các test.
 * Được gọi ở: Nội bộ file src/server/auth/gate-identity.test.ts (truyền vào gateKeyResolver)
 * @returns {string} Chuỗi URL duy nhất dạng https://test-{count}.invalid/__gate/identity-key
 */
function uniqueUrl(): string {
  // Tăng biến đếm để tạo URL duy nhất cho mỗi lần gọi
  urlCounter += 1;
  return `https://test-${urlCounter}.invalid/__gate/identity-key`;
}

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm verifyGateIdentityToken, kiểm tra giải mã và xác minh tính hợp lệ của token JWT.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("verifyGateIdentityToken", () => {
  /**
   * Làm gì: Kiểm tra trường hợp token hợp lệ đầy đủ thông tin (sub, email, name, team_id), trích xuất chính xác GateIdentity.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("returns the identity for a valid token", async () => {
    // Bước 1: Tạo khóa Ed25519 và ký token hợp lệ với đầy đủ claims người dùng
    const key = await makeKey("k1");
    const token = await signToken(key, {
      sub: "user-1",
      email: "viewer@example.com",
      name: "Viewer",
      team_id: "team-9",
      jti: "j1",
    });
    // Bước 2: Xác thực token với đúng issuer, audience và resolver chứa public key tương ứng
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([key.jwk]).fetchImpl),
    });
    // Bước 3: Kiểm tra thông tin danh tính trả về khớp hoàn toàn (team_id được chuẩn hóa sang teamId)
    assert.deepEqual(identity, {
      sub: "user-1",
      email: "viewer@example.com",
      name: "Viewer",
      teamId: "team-9",
    });
  });

  /**
   * Làm gì: Kiểm tra khi token thiếu các claim không bắt buộc (email, name, team_id), hệ thống gán mặc định là null.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("omits optional claims as nulls", async () => {
    // Bước 1: Ký token tối giản chỉ có claim bắt buộc sub và jti
    const key = await makeKey("k1");
    const token = await signToken(key, { sub: "user-2", jti: "j2" });
    // Bước 2: Tiến hành xác thực token với resolver
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([key.jwk]).fetchImpl),
    });
    // Bước 3: Xác nhận các trường vắng mặt trong token được chuẩn hóa thành null thay vì undefined
    assert.deepEqual(identity, {
      sub: "user-2",
      email: null,
      name: null,
      teamId: null,
    });
  });

  /**
   * Làm gì: Kiểm tra cơ chế bảo mật từ chối token nếu trường audience (aud) không khớp với AUDIENCE của ứng dụng.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects a wrong audience", async () => {
    // Bước 1: Ký token dành cho dự án khác (audience là app:other-project thay vì app:proj-123)
    const key = await makeKey("k1");
    const token = await signToken(
      key,
      { sub: "user-1" },
      { audience: "app:other-project" },
    );
    // Bước 2: Xác thực với AUDIENCE của dự án hiện tại, hàm phải từ chối và trả về null
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([key.jwk]).fetchImpl),
    });
    assert.equal(identity, null);
  });

  /**
   * Làm gì: Kiểm tra cơ chế an toàn từ chối token nếu bên phát hành issuer (iss) không khớp với ISSUER tin cậy.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects a wrong issuer", async () => {
    // Bước 1: Ký token với issuer giả mạo bên ngoài (https://evil.example.com)
    const key = await makeKey("k1");
    const token = await signToken(
      key,
      { sub: "user-1" },
      { issuer: "https://evil.example.com" },
    );
    // Bước 2: Xác thực với ISSUER chuẩn của hệ thống, không khớp nên phải trả về null
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([key.jwk]).fetchImpl),
    });
    assert.equal(identity, null);
  });

  /**
   * Làm gì: Kiểm tra từ chối token đã quá hạn sử dụng (thời điểm exp nằm trong quá khứ).
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects an expired token", async () => {
    // Bước 1: Tạo token có mốc phát hành từ 1 giờ trước và thời hạn 5 phút (đã hết hạn)
    const key = await makeKey("k1");
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await signToken(
      key,
      { sub: "user-1" },
      { issuedAt: past, expiresIn: 300 },
    );
    // Bước 2: Xác thực token hết hạn, jwtVerify ném lỗi hết hạn và hàm bắt lỗi trả về null
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([key.jwk]).fetchImpl),
    });
    assert.equal(identity, null);
  });

  /**
   * Làm gì: Kiểm tra token thiếu claim exp bắt buộc, hàm phải từ chối để ngăn chặn token vô thời hạn.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects a token without exp", async () => {
    // Bước 1: Ký token cố tình bỏ qua claim exp (omitExp: true)
    const key = await makeKey("k1");
    const token = await signToken(key, { sub: "user-1" }, { omitExp: true });
    // Bước 2: verifyGateIdentityToken yêu cầu bắt buộc phải có exp (requiredClaims), nên phải trả về null
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([key.jwk]).fetchImpl),
    });
    assert.equal(identity, null);
  });

  /**
   * Làm gì: Kiểm tra phòng chống tấn công giả mạo khóa khi token ký bằng private key khác dù trùng kid ("k1").
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("rejects a token signed by a different key with the same kid", async () => {
    // Bước 1: Tạo hai cặp khóa riêng biệt nhưng cùng đặt kid là 'k1' (một của hệ thống, một của kẻ tấn công)
    const trusted = await makeKey("k1");
    const attacker = await makeKey("k1");
    // Bước 2: Kẻ tấn công dùng khóa riêng của mình để ký token
    const token = await signToken(attacker, { sub: "user-1" });
    // Bước 3: Xác thực bằng public key thật của hệ thống, chữ ký số không khớp nên phải trả về null
    const identity = await verifyGateIdentityToken(token, {
      issuer: ISSUER,
      audience: AUDIENCE,
      getKey: gateKeyResolver(uniqueUrl(), staticJwks([trusted.jwk]).fetchImpl),
    });
    assert.equal(identity, null);
  });

  /**
   * Làm gì: Kiểm tra cơ chế tự động tải lại danh sách JWKS khi gặp token mang kid mới chưa có trong cache.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("refetches the JWKS when the kid rotates", async () => {
    // Bước 1: Khởi tạo 2 khóa cũ/mới và hàm fetchImpl giả lập có thể đổi danh sách khóa công khai động
    const oldKey = await makeKey("k-old");
    const newKey = await makeKey("k-new");
    const url = uniqueUrl();
    let calls = 0;
    let published: JWK[] = [oldKey.jwk];
    const fetchImpl = async (): Promise<GateJwks> => {
      calls += 1;
      return { keys: published };
    };
    const getKey = gateKeyResolver(url, fetchImpl);

    // Bước 2: Lần đầu gặp oldKey, resolver fetch JWKS lần 1 (calls = 1) và xác thực thành công
    const first = await verifyGateIdentityToken(
      await signToken(oldKey, { sub: "user-1" }),
      { issuer: ISSUER, audience: AUDIENCE, getKey },
    );
    assert.equal(first?.sub, "user-1");
    assert.equal(calls, 1);

    // Bước 3: Hệ thống xoay khóa sang newKey; khi gặp kid mới, resolver phát hiện chưa có trong cache nên fetch lại lần 2 (calls = 2)
    published = [newKey.jwk];
    const second = await verifyGateIdentityToken(
      await signToken(newKey, { sub: "user-1" }),
      { issuer: ISSUER, audience: AUDIENCE, getKey },
    );
    assert.equal(second?.sub, "user-1");
    assert.equal(calls, 2);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm gateIdentityFromHeaders, kiểm tra trích xuất và xác thực token từ HTTP request headers.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("gateIdentityFromHeaders", () => {
  /**
   * Làm gì: Kiểm tra luồng xử lý toàn trình (end-to-end) từ header x-grok-identity và cơ chế đóng an toàn (fail-closed) khi thiếu header.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("verifies the header token end to end and fails closed without it", async () => {
    // Bước 1: Thiết lập cấu hình môi trường với GROK_PROJECT_ID và GROK_GATE_ORIGIN
    const key = await makeKey("k1");
    const { fetchImpl } = staticJwks([key.jwk]);
    process.env.GROK_PROJECT_ID = "proj-123";
    process.env.GROK_GATE_ORIGIN = ISSUER;
    try {
      // Bước 2: Ký token và truyền qua header x-grok-identity, hàm xác thực thành công danh tính người dùng
      const token = await signToken(key, {
        sub: "user-1",
        email: "viewer@example.com",
      });
      const withToken = await gateIdentityFromHeaders(
        new Headers({ "x-grok-identity": token }),
        fetchImpl,
      );
      assert.equal(withToken?.sub, "user-1");

      // Bước 3: Gửi request không có header x-grok-identity, hàm fail-closed trả về null
      const withoutToken = await gateIdentityFromHeaders(
        new Headers(),
        fetchImpl,
      );
      assert.equal(withoutToken, null);
    } finally {
      // Dọn dẹp biến môi trường sau khi kiểm thử để tránh ảnh hưởng các test khác
      delete process.env.GROK_PROJECT_ID;
      delete process.env.GROK_GATE_ORIGIN;
    }
  });

  /**
   * Làm gì: Kiểm tra cơ chế tự suy diễn issuer từ host của request trên môi trường production/testing khi không có GROK_GATE_ORIGIN.
   * Được gọi ở: test runner (node --test)
   * @returns {Promise<void>}
   */
  it("activates on a deployed-shaped request without GROK_GATE_ORIGIN", async () => {
    // Bước 1: Chuẩn bị mock fetch theo dõi URL endpoint JWKS mà resolver đã gọi tới
    const key = await makeKey("k-deployed");
    const fetchedFrom: string[] = [];
    const fetchImpl = async (url: string): Promise<GateJwks> => {
      fetchedFrom.push(url);
      return { keys: [key.jwk] };
    };
    // Bước 2: Thiết lập GROK_PROJECT_ID và xóa GROK_GATE_ORIGIN để kích hoạt logic tự suy diễn issuer từ header host
    process.env.GROK_PROJECT_ID = "proj-123";
    // Xóa biến môi trường GROK_GATE_ORIGIN để kiểm tra logic tự động suy diễn issuer từ header host
    delete process.env.GROK_GATE_ORIGIN;
    try {
      // Bước 1: Ký token JWT mang định danh người dùng (sub, email)
      const token = await signToken(key, {
        sub: "user-1",
        email: "viewer@example.com",
      });
      // Bước 2: Gửi request với host thuộc domain testing để hàm tự phân giải issuer tương ứng
      const identity = await gateIdentityFromHeaders(
        new Headers({
          host: "my-app.app-builder-testing.com",
          "x-grok-identity": token,
        }),
        fetchImpl,
      );
      // Bước 3: Xác minh danh tính người dùng và đảm bảo URL JWKS được phân giải chính xác theo domain testing
      assert.equal(identity?.sub, "user-1");
      assert.equal(
        fetchedFrom[0],
        "https://gate.app-builder-testing.com/__gate/identity-key",
      );
    } finally {
      // Dọn dẹp biến môi trường sau kiểm thử
      delete process.env.GROK_PROJECT_ID;
    }
  });

  /**
   * Làm gì: Kiểm tra xác minh token có audience preview khi không có biến môi trường gate, sử dụng cổng loopback mặc định (127.0.0.1:6014).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("verifies a preview-audience token with no gate env vars via the loopback default", async () => {
    // Bước 1: Khởi tạo khóa ký và hàm fetchImpl giả lập để ghi nhận URL tải JWKS
    const key = await makeKey("k-preview");
    const fetchedFrom: string[] = [];
    const fetchImpl = async (url: string): Promise<GateJwks> => {
      fetchedFrom.push(url);
      return { keys: [key.jwk] };
    };
    // Xóa cả hai biến môi trường để mô phỏng môi trường workspace preview chạy cục bộ
    delete process.env.GROK_PROJECT_ID;
    delete process.env.GROK_GATE_ORIGIN;
    // Bước 2: Ký token với issuer loopback (127.0.0.1:6014) và audience "preview"
    const token = await signToken(
      key,
      { sub: "user-1" },
      { issuer: "http://127.0.0.1:6014", audience: "preview" },
    );
    // Bước 3: Gọi gateIdentityFromHeaders với token và host của môi trường sandbox
    const identity = await gateIdentityFromHeaders(
      new Headers({
        host: "my-session.grok-sandbox.com",
        "x-grok-identity": token,
      }),
      fetchImpl,
    );
    // Bước 4: Kiểm tra định danh người dùng được xác thực và JWKS được tải từ cổng loopback 6014
    assert.equal(identity?.sub, "user-1");
    assert.equal(fetchedFrom[0], "http://127.0.0.1:6014/__gate/identity-key");
  });

  /**
   * Làm gì: Kiểm tra cơ chế từ chối token sai issuer trong chế độ loopback mặc định khi token không phát hành từ 127.0.0.1:6014.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects a wrong-issuer token in the loopback default mode", async () => {
    // Bước 1: Khởi tạo khóa ký và xóa các biến môi trường gate để kích hoạt chế độ loopback mặc định
    const key = await makeKey("k-preview-iss");
    const { fetchImpl } = staticJwks([key.jwk]);
    delete process.env.GROK_PROJECT_ID;
    delete process.env.GROK_GATE_ORIGIN;
    // Bước 2: Ký token với issuer từ xa (ISSUER) thay vì issuer loopback mong đợi
    const token = await signToken(
      key,
      { sub: "user-1" },
      { issuer: ISSUER, audience: "preview" },
    );
    // Bước 3: Xác minh token qua headers; do issuer không khớp với loopback nên phải trả về null
    const identity = await gateIdentityFromHeaders(
      new Headers({ "x-grok-identity": token }),
      fetchImpl,
    );
    assert.equal(identity, null);
  });

  /**
   * Làm gì: Kiểm tra xác minh thành công token có audience preview khi chỉ cấu hình GROK_GATE_ORIGIN (chế độ workspace preview).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("verifies a preview-audience token when only GROK_GATE_ORIGIN is set", async () => {
    // Bước 1: Khởi tạo khóa ký và cấu hình GROK_GATE_ORIGIN nhưng không đặt GROK_PROJECT_ID
    const key = await makeKey("k1");
    const { fetchImpl } = staticJwks([key.jwk]);
    delete process.env.GROK_PROJECT_ID;
    process.env.GROK_GATE_ORIGIN = ISSUER;
    try {
      // Bước 2: Ký token với audience "preview" và chỉ chứa claim sub
      const token = await signToken(
        key,
        { sub: "user-1" },
        { audience: "preview" },
      );
      // Bước 3: Xác minh token từ headers thông qua gateIdentityFromHeaders
      const identity = await gateIdentityFromHeaders(
        new Headers({ "x-grok-identity": token }),
        fetchImpl,
      );
      // Bước 4: Kiểm tra kết quả trả về đúng đối tượng identity với các trường không có claim là null
      assert.deepEqual(identity, {
        sub: "user-1",
        email: null,
        name: null,
        teamId: null,
      });
    } finally {
      // Dọn dẹp biến môi trường GROK_GATE_ORIGIN
      delete process.env.GROK_GATE_ORIGIN;
    }
  });

  /**
   * Làm gì: Kiểm tra từ chối token có audience preview khi ứng dụng đã cấu hình GROK_PROJECT_ID (chế độ deployed yêu cầu app:<id>).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects a preview-audience token when GROK_PROJECT_ID is set", async () => {
    // Bước 1: Cấu hình biến môi trường của môi trường đã deploy (yêu cầu audience dạng app:proj-123)
    const key = await makeKey("k1");
    const { fetchImpl } = staticJwks([key.jwk]);
    process.env.GROK_PROJECT_ID = "proj-123";
    process.env.GROK_GATE_ORIGIN = ISSUER;
    try {
      // Bước 2: Ký token với audience "preview" không phù hợp với môi trường đã deploy
      const token = await signToken(
        key,
        { sub: "user-1" },
        { audience: "preview" },
      );
      // Bước 3: Xác minh token; do không khớp audience mong đợi nên kết quả phải là null
      const identity = await gateIdentityFromHeaders(
        new Headers({ "x-grok-identity": token }),
        fetchImpl,
      );
      assert.equal(identity, null);
    } finally {
      // Dọn dẹp các biến môi trường sau kiểm thử
      delete process.env.GROK_PROJECT_ID;
      delete process.env.GROK_GATE_ORIGIN;
    }
  });

  /**
   * Làm gì: Kiểm tra từ chối token có audience app khi ứng dụng đang ở chế độ preview (chưa có GROK_PROJECT_ID).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects an app-audience token in preview mode", async () => {
    // Bước 1: Thiết lập môi trường preview (không có GROK_PROJECT_ID)
    const key = await makeKey("k1");
    const { fetchImpl } = staticJwks([key.jwk]);
    delete process.env.GROK_PROJECT_ID;
    process.env.GROK_GATE_ORIGIN = ISSUER;
    try {
      // Bước 2: Ký token với audience mặc định ("app:proj-123") thay vì "preview"
      const token = await signToken(key, { sub: "user-1" });
      // Bước 3: Xác minh token; do lệch audience mong đợi ("preview") nên kết quả xác thực phải là null
      const identity = await gateIdentityFromHeaders(
        new Headers({ "x-grok-identity": token }),
        fetchImpl,
      );
      assert.equal(identity, null);
    } finally {
      // Dọn dẹp biến môi trường GROK_GATE_ORIGIN
      delete process.env.GROK_GATE_ORIGIN;
    }
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm gateIdentityEnabled, kiểm tra logic xác định tính năng xác thực Gate Identity có được bật hay không.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("gateIdentityEnabled", () => {
  /**
   * Làm gì: Kiểm tra gateIdentityEnabled trả về true theo mặc định khi không cấu hình biến môi trường gate nào.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is enabled by default with no gate env vars", () => {
    // Xóa các biến môi trường gate để kiểm tra giá trị mặc định là bật (true)
    delete process.env.GROK_PROJECT_ID;
    delete process.env.GROK_GATE_ORIGIN;
    assert.equal(gateIdentityEnabled(), true);
  });

  /**
   * Làm gì: Kiểm tra gateIdentityEnabled trả về false khi biến môi trường VITE_AUTH_ENABLED có giá trị là "false".
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is disabled when VITE_AUTH_ENABLED is false", () => {
    // Gán VITE_AUTH_ENABLED = "false" để tắt tính năng xác thực Gate Identity
    process.env.VITE_AUTH_ENABLED = "false";
    try {
      // Xác minh hàm nhận diện chính xác cờ tắt và trả về false
      assert.equal(gateIdentityEnabled(), false);
    } finally {
      // Xóa biến môi trường VITE_AUTH_ENABLED sau kiểm thử
      delete process.env.VITE_AUTH_ENABLED;
    }
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm gateTokenAudience, kiểm tra giá trị claim audience mong đợi theo môi trường triển khai.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("gateTokenAudience", () => {
  /**
   * Làm gì: Kiểm tra gateTokenAudience trả về chuỗi định dạng "app:<id>" khi biến GROK_PROJECT_ID được thiết lập.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("pins app:<id> when GROK_PROJECT_ID is set, even alongside GROK_GATE_ORIGIN", () => {
    // Thiết lập GROK_PROJECT_ID để kích hoạt chế độ deployed app
    process.env.GROK_PROJECT_ID = "proj-123";
    process.env.GROK_GATE_ORIGIN = ISSUER;
    try {
      // Audience phải được gán cố định theo tiền tố "app:" kèm project ID
      assert.equal(gateTokenAudience(), "app:proj-123");
    } finally {
      // Dọn dẹp biến môi trường sau kiểm thử
      delete process.env.GROK_PROJECT_ID;
      delete process.env.GROK_GATE_ORIGIN;
    }
  });

  /**
   * Làm gì: Kiểm tra gateTokenAudience trả về "preview" khi biến GROK_PROJECT_ID không được thiết lập.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("pins preview when GROK_PROJECT_ID is unset", () => {
    // Xóa GROK_PROJECT_ID để đưa hệ thống về môi trường workspace preview
    delete process.env.GROK_PROJECT_ID;
    process.env.GROK_GATE_ORIGIN = ISSUER;
    try {
      // Xác minh audience luôn là "preview" khi chạy ở môi trường preview
      assert.equal(gateTokenAudience(), "preview");
    } finally {
      // Dọn dẹp biến môi trường GROK_GATE_ORIGIN
      delete process.env.GROK_GATE_ORIGIN;
    }
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm gateIdentityUserInfo, kiểm tra việc ánh xạ đối tượng GateIdentity thành hồ sơ GateUserInfo.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("gateIdentityUserInfo", () => {
  /**
   * Làm gì: Kiểm tra cơ chế tự động sinh email dự phòng (.invalid) và tên mặc định ("Grok user") khi identity chỉ có claim sub.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("falls back to a synthetic email and name for sub-only claims", () => {
    // Khi thiếu email và name, hàm tạo email tổng hợp dạng ${sub.toLowerCase()}@viewer.grok.invalid và emailVerified: false
    assert.deepEqual(
      gateIdentityUserInfo({
        sub: "User-1",
        email: null,
        name: null,
        teamId: null,
      }),
      {
        id: "User-1",
        email: "user-1@viewer.grok.invalid",
        emailVerified: false,
        name: "Grok user",
      },
    );
  });

  /**
   * Làm gì: Kiểm tra hàm giữ lại thông tin người dùng thật, chuyển email về chữ thường và đánh dấu emailVerified là true.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps real claims, lowercasing the email and marking it verified", () => {
    // Khi identity có email và name thật, hàm chuẩn hóa email sang chữ thường và đánh dấu emailVerified: true
    assert.deepEqual(
      gateIdentityUserInfo({
        sub: "user-1",
        email: "Viewer@Example.com",
        name: "Viewer",
        teamId: "team-9",
      }),
      {
        id: "user-1",
        email: "viewer@example.com",
        emailVerified: true,
        name: "Viewer",
      },
    );
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm sessionBoundToGateIdentity, kiểm tra tính hợp lệ và khớp danh tính giữa phiên làm việc và token Gate.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("sessionBoundToGateIdentity", () => {
  // Tên nhà cung cấp xác thực liên kết tài khoản giữa Better Auth và Grok Gate
  const provider = "grok-gate";

  /**
   * Làm gì: Kiểm tra hàm trả về true để giữ nguyên phiên làm việc khi tài khoản đã được liên kết với cùng gate sub.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps the session when it is bound to the same gate sub", () => {
    // Tìm thấy liên kết tài khoản có providerId là "grok-gate" và accountId khớp với "user-1" -> giữ nguyên phiên
    assert.equal(
      sessionBoundToGateIdentity(
        [
          { providerId: "google", accountId: "g-1" },
          { providerId: provider, accountId: "user-1" },
        ],
        "user-1",
        provider,
      ),
      true,
    );
  });

  /**
   * Làm gì: Kiểm tra hàm trả về false (yêu cầu xoay phiên làm việc) khi phiên hiện tại thuộc về một gate sub khác.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rotates when the session belongs to a different gate sub", () => {
    // Phiên hiện tại liên kết với "user-1" nhưng token mới mang sub "user-2" -> trả về false để hủy phiên cũ và đăng nhập lại
    assert.equal(
      sessionBoundToGateIdentity(
        [{ providerId: provider, accountId: "user-1" }],
        "user-2",
        provider,
      ),
      false,
    );
  });

  /**
   * Làm gì: Kiểm tra hàm trả về false (yêu cầu xác thực lại) khi người dùng của phiên chưa từng liên kết tài khoản với provider gate.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rotates when the session user has no gate-bound account", () => {
    // Trường hợp có liên kết với bên thứ ba khác (google) nhưng không có liên kết grok-gate -> trả về false
    assert.equal(
      sessionBoundToGateIdentity(
        [{ providerId: "google", accountId: "user-1" }],
        "user-1",
        provider,
      ),
      false,
    );
    // Trường hợp danh sách liên kết rỗng -> trả về false
    assert.equal(sessionBoundToGateIdentity([], "user-1", provider), false);
  });
});
