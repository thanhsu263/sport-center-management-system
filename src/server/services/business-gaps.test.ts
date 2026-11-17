/**
 * Mục đích file:
 * File kiểm thử tích hợp (integration test) kiểm tra việc xử lý các lỗ hổng nghiệp vụ (business gaps) quan trọng trong hệ thống Arena3.
 * Bao gồm: G0 (luồng hoàn tiền mặt, phê duyệt của quản lý và ca thu ngân), G7 (tính toán tiến độ buổi học có mặt/muộn), G1 (cơ chế đổi điểm thưởng loyalty, chống race condition, thu hồi voucher và xử lý nợ điểm khi hoàn tiền).
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) với cơ sở dữ liệu nhúng PGlite, kiểm tra tương tác giữa các service/handler nghiệp vụ (bookings, desk, training, classes, loyalty, promos) và các ràng buộc dữ liệu thực tế.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PublicUser } from "../controllers/session";

process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock";
process.env.PGLITE_DATA_DIR = "memory";
register(pathToFileURL("./scripts/tests/agent/ttf-loader.mjs"));
const { setOverridePglite, withTx } = await import("../controllers/tx");
const { bookingsCancel, bookingsCancelQuote } = await import("../controllers/handlers/bookings");
const { paymentsRefund, paymentsApproveRefund, paymentsPayOutRefund, paymentsPending, shiftCurrent } = await import("../controllers/handlers/desk");
const { meTraining } = await import("../controllers/handlers/training");
const { classesPatch } = await import("../controllers/handlers/classes");

let db: PGlite;
let member: PublicUser, desk: PublicUser, payer: PublicUser, manager: PublicUser, coach: PublicUser;
let court: string;
let seq = 0;
/**
 * Làm gì: Khởi tạo đối tượng Request giả lập với phương thức POST và định dạng JSON để gửi dữ liệu kiểm thử đến các handler.
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử hủy đặt sân, hoàn tiền và đổi điểm).
 * @param body Dữ liệu payload JSON cần truyền trong phần thân của request.
 * @returns Đối tượng Request chứa body đã được mã hóa JSON và header content-type tương ứng.
 */
const request = (body: object) => new Request("http://localhost/v1/test", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
/**
 * Làm gì: Truy vấn dữ liệu một bản ghi thanh toán từ bảng payments trong cơ sở dữ liệu để kiểm tra trạng thái và ca thu ngân.
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử G0 để kiểm tra khoản hoàn tiền).
 * @param id Mã định danh UUID của bản ghi thanh toán trong bảng payments.
 * @returns Đối tượng chứa status, method, amount_vnd và shift_id của khoản thanh toán.
 */
const row = async (id: string) => (await db.query<{ status: string; method: string; amount_vnd: number; shift_id: string | null }>(
  "select status::text, method::text, amount_vnd, shift_id from payments where id=$1", [id],
)).rows[0];

/**
 * Làm gì: Thiết lập môi trường kiểm thử: khởi tạo database PGlite in-memory, chạy migrations, tạo tài khoản mẫu và cấu hình hạn mức hoàn tiền.
 * Được gọi ở: test runner (node --test)
 * @returns Promise<void>
 */
before(async () => {
  // Bước 1: Khởi tạo cơ sở dữ liệu PGlite trong bộ nhớ và chờ sẵn sàng
  db = new PGlite();
  await db.waitReady;
  // Bước 2: Nạp schema database bằng cách đọc và thực thi lần lượt tất cả các file migration SQL
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(`migrations/${f}`, "utf8"));
  }
  // Bước 3: Ghi đè kết nối PGlite vào transaction controller để các handler thực thi trên database in-memory
  setOverridePglite(db);
  // Bước 4: Khởi tạo danh sách người dùng mẫu với các vai trò khác nhau (member, receptionist, manager, coach)
  const users: PublicUser[] = [];
  for (const role of ["member", "receptionist", "receptionist", "manager", "coach"]) {
    const id = randomUUID();
    await db.query(`insert into users (id, phone, full_name, name_normalized, role, password_hash)
      values ($1,$2,'Gap test','gap test',$3,'hash')`, [id, `09777777${users.length.toString().padStart(2, "0")}`, role]);
    users.push({ id, role, full_name: "Gap test" } as PublicUser);
  }
  [member, desk, payer, manager, coach] = users;
  // Bước 5: Tạo sân thi đấu thử nghiệm, cấu hình ngưỡng hoàn tiền của quản lý (1.000.000 VNĐ) và bật cờ tính năng F4
  court = (await db.query<{ id: string }>("insert into courts (court_code, sport, status) values ('GAP-TEST','badminton','ready') returning id")).rows[0].id;
  await db.exec("update center_settings set refund_manager_vnd = 1000000; update feature_flags set enabled=true where key='F4'");
});
/**
 * Làm gì: Dọn dẹp tài nguyên sau khi toàn bộ bài test kết thúc: hủy ghi đè PGlite và đóng kết nối cơ sở dữ liệu.
 * Được gọi ở: test runner (node --test)
 * @returns Promise<void>
 */
after(async () => { setOverridePglite(null); await db?.close(); });

/**
 * Làm gì: Tạo dữ liệu giả lập một lượt đặt sân kèm khung giờ chiếm dụng và hóa đơn thanh toán thành công để phục vụ kiểm thử.
 * Được gọi ở: business-gaps.test.ts (trong các kịch bản kiểm thử G0 và G1).
 * @param amount Số tiền thanh toán cho lượt đặt sân tính theo VNĐ (mặc định 100.000 VNĐ).
 * @param owner Tài khoản hội viên sở hữu lượt đặt sân (mặc định là biến member).
 * @returns Đối tượng chứa id của lượt đặt sân và id của hóa đơn thanh toán.
 */
async function booking(amount = 100000, owner = member) {
  // Bước 1: Sinh mã UUID và tính toán mốc ngày tăng dần luôn nằm trong tương lai
  const id = randomUUID();
  const day = ++seq;
  // Relative to the database clock, always in the future regardless of the time of day.
  // Bước 2: Thêm bản ghi chiếm dụng sân (occupancies) cho khung giờ đặt sân
  const occ = (await db.query<{ id: string }>(`insert into occupancies (court_id,start_at,end_at,kind,ref_id)
    values ($1,now()+$3*interval '1 day',now()+$3*interval '1 day'+interval '1 hour','booking',$2) returning id`, [court,id,day])).rows[0].id;
  // Bước 3: Tạo lượt đặt sân (court_bookings) ở trạng thái đã xác nhận (confirmed) qua app
  await db.query(`insert into court_bookings (id,code,court_id,user_id,start_at,end_at,status,channel,price_vnd,paid_vnd,occupancy_id)
    select $1,$2,$3,$4,start_at,end_at,'confirmed','app',$5,$5,id from occupancies where id=$6`, [id,`BK-GAP-${day}`,court,owner.id,amount,occ]);
  // Bước 4: Tạo giao dịch thanh toán thành công (posted) qua phương thức thẻ (card)
  const payment = (await db.query<{ id: string }>(`insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
    values ($1,$2,'card',$3,0,'posted','booking',$4) returning id`, [`PAY-GAP-${day}`,owner.id,amount,id])).rows[0].id;
  return { id, payment };
}
/**
 * Làm gì: Mở ca làm việc thu ngân mới cho nhân viên lễ tân, tự động đóng ca làm việc cũ nếu vẫn chưa chốt.
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử chi tiền mặt hoàn phí).
 * @param user Tài khoản nhân viên lễ tân/thu ngân cần mở ca.
 * @returns Mã UUID của ca thu ngân mới tạo trong bảng cashier_shifts.
 */
async function openShift(user: PublicUser) {
  // Bước 1: Đóng ca thu ngân trước đó của nhân viên nếu ca đó vẫn còn mở (closed_at is null)
  await db.query("update cashier_shifts set closed_at=now() where receptionist_id=$1 and closed_at is null", [user.id]);
  // Bước 2: Tạo ca thu ngân mới cho nhân viên và trả về shift_id
  return (await db.query<{ id: string }>("insert into cashier_shifts (receptionist_id) values ($1) returning id", [user.id])).rows[0].id;
}

/**
 * Làm gì: Nhóm các ca kiểm thử cho lỗ hổng G0: Đảm bảo tiền hoàn mặt luôn ở trạng thái chờ (refund_pending) cho đến khi thu ngân chi tiền tại quầy.
 * Được gọi ở: test runner (node --test)
 */
describe("G0: cash refunds are owed until paid at the desk", () => {
  /**
   * Làm gì: Kiểm tra quy tắc hội viên tự hủy lịch thì không được hoàn tiền (0%), kể cả khi cố tình gửi cờ miễn phạt (waive).
   * Được gọi ở: test runner (node --test)
   */
  it("member quotes and cancellation refund nothing, even with a forged waiver", async () => {
    // Bước 1: Tạo lượt đặt sân ban đầu cho hội viên
    const b = await booking();
    // Bước 2: Lấy báo giá hủy sân khi truyền waive=1 giả mạo; kiểm tra hệ thống bỏ qua cờ này và báo hoàn 0 VNĐ (0%)
    const quote = await withTx((sql) => bookingsCancelQuote(sql,b.id,new Request("http://localhost/cancel?waive=1"),member));
    assert.equal(quote.body.refund_vnd,0);
    assert.equal(quote.body.refund_pct,0);
    // Bước 3: Thực hiện hủy đặt sân thực tế; xác nhận không tạo khoản hoàn tiền nào và không có thanh toán âm
    const cancelled = await withTx((sql) => bookingsCancel(sql,b.id,member,request({ waive:true })));
    assert.equal(cancelled.body.refund,null);
    assert.equal((await db.query("select id from payments where ref_id=$1 and amount_vnd<0",[b.id])).rows.length,0);
  });

  /**
   * Làm gì: Kiểm tra trung tâm hủy sân bắt buộc có lý do, tự động tạo khoản hoàn tiền mặt chờ duyệt và thu ngân chỉ chi được khi có ca mở.
   * Được gọi ở: test runner (node --test)
   */
  it("centre cancellation requires a reason and creates a full pending cash refund below the threshold", async () => {
    // Bước 1: Tạo lượt đặt sân ban đầu trị giá 100.000 VNĐ
    const b = await booking();
    // Bước 2: Lễ tân hủy đặt sân nhưng lý do chỉ chứa khoảng trắng -> hệ thống phải từ chối do thiếu lý do hợp lệ
    await assert.rejects(() => withTx((sql) => bookingsCancel(sql,b.id,desk,request({waive:true,reason:" "}))));
    // Bước 3: Lễ tân hủy đặt sân với lý do hợp lệ ("Court closed") kèm cờ waive do lỗi từ phía trung tâm
    const cancelled = await withTx((sql) => bookingsCancel(sql,b.id,desk,request({waive:true,reason:"Court closed"})));
    assert.ok(cancelled.body.refund && "id" in cancelled.body.refund);
    const id = cancelled.body.refund.id;
    // Bước 4: Kiểm tra bản ghi hoàn tiền được tạo ở trạng thái refund_pending, phương thức cash (-100.000 VNĐ) và chưa gắn vào ca nào
    assert.deepEqual(await row(id), {status:"refund_pending",method:"cash",amount_vnd:-100000,shift_id:null});
    // Bước 5: Nhân viên thu ngân chưa mở ca mà đòi chi tiền mặt -> bị chặn bởi luật nghiệp vụ BR-44 (bắt buộc phải có ca mở)
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,payer)), (e: any) => e.extra?.br === "BR-44");
    // Bước 6: Nhân viên thu ngân mở ca làm việc và thực hiện chi trả tiền mặt cho khách
    const shift = await openShift(payer);
    await withTx((sql) => paymentsPayOutRefund(sql,id,payer));
    // Bước 7: Xác minh khoản hoàn đã được gắn vào shift_id của ca hiện tại và tổng tiền mặt trong ca bị trừ 100.000 VNĐ
    assert.equal((await row(id)).shift_id,shift);
    const current = await withTx((sql) => shiftCurrent(sql,payer,new Request("http://localhost/current")));
    assert.equal(current.body.totals?.cash,-100000);
    // Bước 8: Thử chi trả lại khoản hoàn đã thanh toán -> hệ thống phải từ chối để tránh chi trùng
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,payer)));
  });

  /**
   * Làm gì: Kiểm tra khoản hoàn tiền lớn vượt ngưỡng (trên 1.000.000 VNĐ) bắt buộc quản lý phê duyệt, và bước duyệt không làm xuất tiền mặt.
   * Được gọi ở: test runner (node --test)
   */
  it("large automatic refunds require manager approval, which itself moves no cash", async () => {
    // Bước 1: Tạo lượt đặt sân trị giá 1.200.000 VNĐ (vượt hạn mức tự động hoàn 1.000.000 VNĐ)
    const b = await booking(1200000);
    // Bước 2: Quản lý thực hiện hủy đặt sân do trung tâm đóng cửa
    const cancelled = await withTx((sql) => bookingsCancel(sql,b.id,manager,request({waive:true,reason:"Court closed"})));
    assert.ok(cancelled.body.refund && "id" in cancelled.body.refund);
    const id = cancelled.body.refund.id;
    // Bước 3: Thu ngân cố gắng chi tiền mặt khi chưa được duyệt -> bị từ chối do vượt hạn mức cần phê duyệt
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,payer)));
    // Bước 4: Quản lý thực hiện phê duyệt khoản hoàn tiền lớn
    await withTx((sql) => paymentsApproveRefund(sql,id,request({}),manager));
    // Bước 5: Xác nhận sau khi phê duyệt: trạng thái vẫn là refund_pending và chưa gán ca (chưa xuất tiền khỏi két)
    assert.equal((await row(id)).status,"refund_pending");
    assert.equal((await row(id)).shift_id,null);
    // Bước 6: Thu ngân thực hiện chi trả tiền mặt thực tế sau khi đã được phê duyệt thành công -> chuyển sang posted
    await withTx((sql) => paymentsPayOutRefund(sql,id,payer));
    assert.equal((await row(id)).status,"posted");
  });

  /**
   * Làm gì: Kiểm tra hoàn tiền thủ công bắt buộc có lý do, duy trì trạng thái chờ và trừ tiền vào ca của người thực chi thay vì người tạo phiếu.
   * Được gọi ở: test runner (node --test)
   */
  it("manual refunds require a reason, stay pending, and debit the payer's new shift rather than the raiser's", async () => {
    // Bước 1: Tạo lượt đặt sân và mở ca thu ngân cho nhân viên lễ tân đề xuất hoàn tiền
    const b = await booking();
    const raisedShift = await openShift(desk);
    // Bước 2: Thử tạo yêu cầu hoàn tiền thủ công nhưng thiếu lý do -> hệ thống từ chối
    await assert.rejects(() => withTx((sql) => paymentsRefund(sql,b.payment,request({amount_vnd:40000}),desk)));
    // Bước 3: Tạo yêu cầu hoàn tiền thủ công 40.000 VNĐ với lý do hợp lệ ("Staff decision")
    const refund = await withTx((sql) => paymentsRefund(sql,b.payment,request({amount_vnd:40000,reason:"Staff decision"}),desk));
    const id = (refund.body.payment as {id:string}).id;
    assert.equal((await row(id)).status,"refund_pending");
    // Bước 4: Nhân viên chi trả (payer) mở ca thu ngân mới và thực hiện chi tiền mặt
    const shift = await openShift(payer);
    await withTx((sql) => paymentsPayOutRefund(sql,id,payer));
    // Bước 5: Xác minh khoản hoàn tiền được ghi nhận vào ca của người chi trả thực tế (payer), không trừ vào ca của người đề xuất (desk)
    assert.equal((await row(id)).shift_id,shift);
    assert.notEqual(shift,raisedShift);
    // Bước 6: Kiểm tra danh sách các khoản hoàn tiền đang chờ xử lý từ góc nhìn của lễ tân
    const queue = await withTx((sql) => paymentsPending(sql,new Request("http://localhost/pending"),desk));
    assert.ok("refunds" in queue.body);
  });

  /**
   * Làm gì: Kiểm tra hủy lớp học tạo khoản hoàn tiền chờ xử lý, và quản lý không có ca thu ngân (không có két tiền) sẽ bị chặn chi tiền mặt (BR-44).
   * Được gọi ở: test runner (node --test)
   */
  it("class cancellation stays pending and a manager without a till cannot pay it out", async () => {
    // Bước 1: Tạo lớp học, ghi danh hội viên và ghi nhận giao dịch thanh toán học phí 200.000 VNĐ đã hoàn tất
    const cl = await makeClass();
    const seat = (await db.query<{id:string}>("insert into enrollments (class_id,user_id,status,price_vnd) values ($1,$2,'confirmed',200000) returning id",[cl,member.id])).rows[0].id;
    await db.query(`insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
      values ('PAY-GAP-CLASS',$1,'transfer',200000,0,'posted','enrollment',$2)`,[member.id,seat]);
    // Bước 2: Quản lý cập nhật trạng thái lớp học sang hủy (cancelled) với lý do trung tâm đóng cửa
    await withTx((sql) => classesPatch(sql,cl,request({status:"cancelled",reason:"Centre closed"}),manager));
    // Bước 3: Tìm giao dịch hoàn tiền học phí vừa được tạo tự động và xác minh trạng thái refund_pending (-200.000 VNĐ tiền mặt)
    const id = (await db.query<{id:string}>("select id from payments where ref_id=$1 and amount_vnd<0",[seat])).rows[0].id;
    assert.deepEqual(await row(id),{status:"refund_pending",method:"cash",amount_vnd:-200000,shift_id:null});
    // Bước 4: Quản lý cố gắng chi tiền mặt mà không có ca thu ngân đang mở -> bị chặn bởi luật BR-44
    await assert.rejects(() => withTx((sql) => paymentsPayOutRefund(sql,id,manager)),(e:any)=>e.extra?.br === "BR-44");
  });
});

/**
 * Làm gì: Tạo dữ liệu giả lập một lớp học cầu lông (classes) cho người mới bắt đầu với lịch học định kỳ vào thứ Hai hàng tuần.
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử hủy lớp học và tính tiến độ đào tạo).
 * @returns Mã UUID của lớp học mới tạo trong bảng classes.
 */
async function makeClass() {
  return (await db.query<{id:string}>(`insert into classes (sport,level,coach_id,court_id,capacity,rrule,start_on,end_on,status)
    values ('badminton','beginner',$1,$2,10,'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10',current_date-30,current_date+30,'open') returning id`,[coach.id,court])).rows[0].id;
}
/**
 * Làm gì: Kiểm tra lỗ hổng G7: Tiến độ tập luyện tính đủ các buổi có mặt và đi muộn, đồng thời loại trừ buổi vắng, buổi hủy và người khác.
 * Được gọi ở: test runner (node --test)
 */
it("G7 Progress counts present and late attendance beyond the results page, excluding other users and cancelled sessions", async () => {
  // Bước 1: Tạo một lớp học mẫu
  const cl = await makeClass();
  // Bước 2: Tạo chuỗi 14 buổi học trong quá khứ: buổi n=13 bị hủy, buổi n=12 hội viên vắng mặt, các buổi khác xen kẽ có mặt và đi muộn
  for (let n=0;n<14;n++) {
    const session = (await db.query<{id:string}>(`insert into sessions (class_id,court_id,start_at,end_at,status)
      values ($1,$2,now()-($3+1)*interval '1 day',now()-($3+1)*interval '1 day'+interval '1 hour',$4) returning id`,[cl,court,n,n===13?'cancelled':'done'])).rows[0].id;
    await db.query("insert into attendance (kind,user_id,session_id,result) values ('session',$1,$2,$3)", [member.id,session,n===12?'absent':n%2?'late':'present']);
    await db.query("insert into attendance (kind,user_id,session_id,result) values ('session',$1,$2,'present')",[coach.id,session]);
  }
  // Bước 3: Gọi API meTraining để lấy tiến độ tập luyện của hội viên
  const progress = await withTx((sql) => meTraining(sql,member));
  // Bước 4: Xác minh danh sách results phân trang trả về rỗng nhưng tổng số buổi hoàn thành vẫn tính đúng 12 buổi (14 buổi - 1 buổi hủy - 1 buổi vắng)
  assert.equal(progress.body.results.length,0);
  assert.equal(progress.body.completed_sessions,12);
});

const { loyaltyRedeem } = await import("../controllers/handlers/extras");
const { loyaltyBalance, reconcileLoyaltyRefund } = await import("./loyalty");
const { quotePromo, redeemPromo } = await import("./promos");
/**
 * Làm gì: Tạo một tài khoản hội viên mới chuyên biệt cho kiểm thử điểm thưởng loyalty với số điện thoại duy nhất.
 * Được gọi ở: business-gaps.test.ts (trong các kịch bản kiểm thử G1 loyalty).
 * @returns Đối tượng PublicUser đại diện cho hội viên vừa tạo.
 */
async function loyaltyMember() {
  const id = randomUUID();
  await db.query(`insert into users (id,phone,full_name,name_normalized,role,password_hash)
    values ($1,$2,'Loyalty test','loyalty test','member','hash')`, [id, '0966'+String(++seq).padStart(6,'0')]);
  return { id, role: 'member', full_name: 'Loyalty test' } as PublicUser;
}
/**
 * Làm gì: Hàm tiện ích thực hiện giao dịch đổi điểm thưởng loyalty lấy mã ưu đãi giảm giá (voucher).
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử G1).
 * @param u Tài khoản hội viên thực hiện đổi điểm.
 * @param points Số lượng điểm thưởng muốn quy đổi.
 * @returns Phản hồi từ handler loyaltyRedeem chứa mã voucher và số điểm còn lại.
 */
const redeem = (u: PublicUser, points: number) => withTx(sql => loyaltyRedeem(sql,request({points}),u));
/**
 * Làm gì: Hàm tiện ích truy vấn số dư điểm thưởng loyalty của hội viên kèm tùy chọn giới hạn điểm không âm (clamp).
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử G1).
 * @param u Tài khoản hội viên cần tra cứu số dư điểm.
 * @param clamp Có ép số dư âm về 0 hay không (mặc định true).
 * @returns Thông tin số dư điểm (points) và tỷ lệ tích điểm theo doanh thu (earn_vnd).
 */
const balance = (u: PublicUser, clamp = true) => withTx(sql => loyaltyBalance(sql,u.id,clamp));
/**
 * Làm gì: Tra cứu mã định danh UUID của một chương trình khuyến mãi trong bảng promotions dựa trên chuỗi mã code.
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử G1).
 * @param code Chuỗi mã code của chương trình khuyến mãi.
 * @returns Mã UUID của bản ghi khuyến mãi tương ứng.
 */
const promoId = async (code: string) => (await db.query<{id:string}>("select id from promotions where code=$1",[code])).rows[0].id;
/**
 * Làm gì: Hàm tiện ích tính toán giá trị ưu đãi khi áp dụng mã voucher cho đơn đặt sân mẫu trị giá 1.000.000 VNĐ.
 * Được gọi ở: business-gaps.test.ts (trong các ca kiểm thử G1).
 * @param u Tài khoản người dùng áp dụng mã voucher (hoặc null nếu chưa đăng nhập).
 * @param code Chuỗi mã voucher khuyến mãi cần kiểm tra.
 * @returns Kết quả tính giá ưu đãi gồm số tiền được giảm (discount_vnd).
 */
const quote = (u: PublicUser | null, code: string) => withTx(sql => quotePromo(sql,{code,userId:u?.id ?? null,scope:'court',orderVnd:1000000}));

/**
 * Làm gì: Nhóm các ca kiểm thử cho lỗ hổng G1: Đảm bảo điểm thưởng loyalty thuộc quyền sở hữu cá nhân và không thể tồn tại vượt quá doanh thu tích lũy sau khi hoàn tiền.
 * Được gọi ở: test runner (node --test)
 */
describe("G1: loyalty rewards keep their owner and cannot outlive refunded earnings", () => {
  /**
   * Làm gì: Kiểm tra cơ chế khóa tài khoản (FOR UPDATE) trước khi đọc điểm tích lũy để chặn race condition khi có 2 yêu cầu đổi điểm đồng thời.
   * Được gọi ở: test runner (node --test)
   */
  it("locks the member before reading earnings and rejects a competing redemption", async () => {
    // Bước 1: Tạo hội viên thử nghiệm, lấy tỷ lệ tích điểm và đặt sân để tích lũy đủ 50 điểm
    const u = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    await booking(50*earn,u);
    // Bước 2: Bọc câu lệnh query của transaction đầu tiên để ghi lại danh sách SQL nhằm kiểm tra thứ tự khóa
    const queries: string[] = [];
    const first = withTx(async sql => {
      const original = sql.query.bind(sql);
      sql.query = ((text: string, params?: unknown[]) => { queries.push(text); return original(text,params); }) as typeof sql.query;
      return loyaltyRedeem(sql,request({points:50}),u);
    });
    // Bước 3: Kích hoạt đồng thời 2 yêu cầu đổi 50 điểm -> chỉ 1 yêu cầu thành công, yêu cầu còn lại bị từ chối
    const outcomes = await Promise.allSettled([first,redeem(u,50)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);
    // Bước 4: Xác minh trong log truy vấn: câu lệnh khóa FOR UPDATE trên bảng users phải được gọi trước câu lệnh SUM doanh thu
    const lock = queries.findIndex(q=>q.includes('from users') && q.includes('for update'));
    const earnings = queries.findIndex(q=>q.includes('sum(amount_vnd)'));
    assert.ok(lock>=0 && earnings>lock);
    // Bước 5: Kiểm tra số điểm còn lại của người dùng đã về 0 sau khi đổi thưởng thành công
    assert.equal((await balance(u)).points,0);
  });

  /**
   * Làm gì: Kiểm tra voucher chỉ cho phép chính chủ sử dụng và tự động vô hiệu hóa (void) voucher mới nhất chưa dùng khi có hoàn tiền tại quầy.
   * Được gọi ở: test runner (node --test)
   */
  it("allows only the owner at quote and payment, then voids the newest unused code once on a desk refund", async () => {
    // Bước 1: Tạo hai người dùng (chủ sở hữu u và người lạ stranger), đặt sân đủ điểm đổi 2 voucher (50 điểm và 100 điểm)
    const u = await loyaltyMember(), stranger = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    const b = await booking(150*earn,u);
    const old = (await redeem(u,50)).body.code;
    const newest = (await redeem(u,100)).body.code;
    // Bước 2: Điều chỉnh ngày tạo voucher cũ lùi về hôm trước để phân định rõ thứ tự cũ/mới
    await db.query("update loyalty_adjustments set created_at=now()-interval '1 day' where promo_id=$1",[await promoId(old)]);
    // Bước 3: Báo giá voucher mới nhất: người dùng u được giảm giá, nhưng stranger hoặc khách chưa đăng nhập (null) bị chặn bởi lỗi BR-40
    assert.ok((await quote(u,newest)).discount_vnd>0);
    await assert.rejects(()=>quote(stranger,newest),(e:any)=>e.extra?.br==='BR-40');
    await assert.rejects(()=>quote(null,newest),(e:any)=>e.extra?.br==='BR-40');
    // Bước 4: Người lạ cố tình áp dụng voucher khi thanh toán cũng bị từ chối bởi quy tắc BR-40
    const id = await promoId(newest);
    await assert.rejects(()=>withTx(sql=>redeemPromo(sql,{promoId:id,userId:stranger.id,paymentId:b.payment,discountVnd:100})),(e:any)=>e.extra?.br==='BR-40');
    // Bước 5: Quản lý hoàn tiền một phần đơn đặt sân (50 điểm doanh thu), dẫn đến việc thu hồi voucher chưa sử dụng mới nhất (100 điểm)
    await withTx(sql=>paymentsRefund(sql,b.payment,request({amount_vnd:50*earn,reason:'Centre adjustment'}),manager));
    // Bước 6: Xác nhận voucher mới nhất đã bị vô hiệu hóa, trong khi voucher cũ (50 điểm) vẫn còn hiệu lực sử dụng
    await assert.rejects(()=>quote(u,newest));
    assert.ok((await quote(u,old)).discount_vnd>0);
    await assert.rejects(()=>withTx(sql=>redeemPromo(sql,{promoId:id,userId:u.id,paymentId:b.payment,discountVnd:100})),(e:any)=>e.extra?.br==='BR-40');
    // Bước 7: Đối soát điểm hoàn tiền (reconcileLoyaltyRefund) và kiểm tra bản ghi điều chỉnh bù trừ (correction) hoàn trả 100 điểm đã thu hồi
    await withTx(sql=>reconcileLoyaltyRefund(sql,u.id));
    const corrections = (await db.query<{points:number;note:string}>("select points,note from loyalty_adjustments where user_id=$1 and reason='correction'",[u.id])).rows;
    assert.deepEqual(corrections,[{points:100,note:newest}]);
    assert.equal((await balance(u)).points,50);
  });

  /**
   * Làm gì: Kiểm tra trung tâm hủy sân vẫn giữ nguyên mã voucher đã dùng và ghi nhận nợ điểm âm; doanh thu sau này sẽ bù nợ trước khi đổi điểm mới.
   * Được gọi ở: test runner (node --test)
   */
  it("centre cancellation preserves used codes and debt, which future earnings repay before redemption", async () => {
    // Bước 1: Tạo hội viên, tích lũy điểm và đổi mã voucher 100 điểm rồi áp dụng thanh toán cho đơn đặt sân
    const u = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    const b = await booking(100*earn,u);
    const code = (await redeem(u,100)).body.code;
    const id = await promoId(code);
    await withTx(sql=>redeemPromo(sql,{promoId:id,userId:u.id,paymentId:b.payment,discountVnd:100}));
    // Bước 2: Trung tâm hủy sân, quản lý phê duyệt và thu ngân chi trả tiền mặt khoản hoàn cho đơn đặt sân ban đầu
    await withTx(sql=>bookingsCancel(sql,b.id,manager,request({waive:true,reason:'Centre closed'})));
    const refundId = (await db.query<{id:string}>("select id from payments where ref_id=$1 and amount_vnd<0",[b.id])).rows[0].id;
    await withTx(sql=>paymentsApproveRefund(sql,refundId,request({}),manager));
    await openShift(payer);
    await withTx(sql=>paymentsPayOutRefund(sql,refundId,payer));
    // Bước 3: Xác nhận voucher đã dùng vẫn giữ nguyên trạng thái applied, nhưng số dư điểm thực tế thành số âm (-100 điểm nợ)
    assert.equal((await db.query<{status:string}>("select status from promotion_redemptions where promo_id=$1",[id])).rows[0].status,'applied');
    assert.equal((await balance(u,false)).points,-100);
    assert.equal((await balance(u)).points,0);
    assert.equal((await db.query("select id from loyalty_adjustments where user_id=$1 and reason='correction'",[u.id])).rows.length,0);
    // Bước 4: Khách đặt sân mới tích lũy được 50 điểm doanh thu -> điểm thực tế tăng từ -100 lên -50 (vẫn âm nên không thể đổi điểm)
    await booking(50*earn,u);
    assert.equal((await balance(u,false)).points,-50);
    await assert.rejects(()=>redeem(u,50));
    // Bước 5: Khách tiếp tục đặt sân thêm 100 điểm doanh thu -> trả hết nợ và dư 50 điểm dương, cho phép đổi tiếp điểm thưởng
    await booking(100*earn,u);
    assert.equal((await balance(u)).points,50);
    assert.equal((await redeem(u,50)).body.points_left,0);
  });

  /**
   * Làm gì: Kiểm tra việc hoàn tiền học phí lớp học giúp bù trừ nợ điểm hiện có nhưng tiền học phí không được tính vào doanh thu tích điểm thưởng.
   * Được gọi ở: test runner (node --test)
   */
  it("class refunds reconcile existing debt without adding tuition to loyalty earnings", async () => {
    // Bước 1: Tạo hội viên, tích lũy điểm đặt sân và đổi mã voucher 50 điểm
    const u = await loyaltyMember();
    const earn = (await balance(u)).earn_vnd;
    await booking(50*earn,u);
    const code = (await redeem(u,50)).body.code;
    // Bước 2: Giả lập khoản nợ điểm âm (-50 điểm) qua bản ghi điều chỉnh correction
    await db.query("insert into loyalty_adjustments (user_id,points,reason,note) values ($1,-50,'correction','Test debit')",[u.id]);
    // Bước 3: Hội viên đăng ký và thanh toán học phí lớp học 200.000 VNĐ
    const cl = await makeClass();
    const seat = (await db.query<{id:string}>("insert into enrollments (class_id,user_id,status,price_vnd) values ($1,$2,'confirmed',200000) returning id",[cl,u.id])).rows[0].id;
    await db.query(`insert into payments (code,user_id,method,amount_vnd,vat_rate,status,ref_type,ref_id)
      values ($1,$2,'card',200000,0,'posted','enrollment',$3)`,['PAY-G1-'+(++seq),u.id,seat]);
    // Bước 4: Trung tâm hủy lớp học -> kích hoạt đối soát hoàn tiền lớp học
    await withTx(sql=>classesPatch(sql,cl,request({status:'cancelled',reason:'Centre closed'}),manager));
    // Bước 5: Xác nhận voucher cũ bị vô hiệu hóa để bù nợ, đưa số dư thực tế về 0 điểm (học phí lớp học không sinh thêm điểm tích lũy)
    await assert.rejects(()=>quote(u,code));
    assert.equal((await balance(u,false)).points,0);
  });
});
