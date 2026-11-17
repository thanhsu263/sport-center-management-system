/**
 * Test suite kiểm thử toàn diện kịch bản tạo dữ liệu mẫu (seed demo) trong scripts/seed-lively.mjs.
 * Xác minh tính tất định (idempotent), khóa giao dịch (transaction lock), rào chắn an toàn cho production,
 * tính tương thích với PGlite trên Windows và toàn bộ các bất biến tài chính / nghiệp vụ của Arena 3.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ACTIVITY, WINDOW_START, demand, random, id, normalize, protectedLogin, suspiciousUser, writableTarget, migrate, populate, verify, prepareLocalDirectory, replaceActivity } from './seed-lively.mjs';

/**
 * Làm gì: Kiểm tra cơ chế khóa bảng độc quyền (ACCESS EXCLUSIVE) ngay sau BEGIN trước khi đọc dữ liệu trong replaceActivity, và tự động rollback khi gặp sự cố.
 * Được gọi ở: test runner (node --test).
 * @returns {Promise<void>} Không trả về giá trị, ném AssertionError nếu hành vi khóa hoặc rollback sai lệch.
 * @throws {AssertionError} Ném lỗi khi thứ tự truy vấn hoặc trạng thái transaction không đúng kỳ vọng.
 */
test('bulk replacement locks before any read, and rolls back on failure', async () => {
  // Bước 1: Khởi tạo mock database ghi nhận thứ tự câu lệnh SQL và giả lập lỗi ngắt quãng khi đọc dữ liệu
  const calls = [];
  const stopped = new Error('stop before reading');
  const db = { exec: async sql => calls.push(sql), query: async sql => { calls.push(sql); throw stopped; } };
  // Bước 2: Thực thi replaceActivity và kiểm tra hàm bắt buộc phải ném đúng lỗi giả lập
  await assert.rejects(replaceActivity(db, '2026-11-09T16:00:00Z'), stopped);
  // Bước 3: Xác minh an toàn giao dịch: bắt buộc BEGIN -> LOCK EXCLUSIVE toàn bộ bảng activity và users trước khi SELECT -> cuối cùng ROLLBACK
  assert.equal(calls[0], 'begin');
  assert.equal(calls[1], `lock table ${ACTIVITY.join(', ')}, users in access exclusive mode`);
  assert.match(calls[2], /^select/);
  assert.equal(calls.at(-1), 'rollback');
});

/**
 * Làm gì: Kiểm tra mô hình dự báo nhu cầu (demand) theo giờ trong ngày, ngày trong tuần, các dịp lễ và tính ngẫu nhiên tất định từ hàm random().
 * Được gọi ở: test runner (node --test).
 * @returns {void} Không trả về giá trị, ném AssertionError nếu kết quả tính nhu cầu không đúng quy luật.
 * @throws {AssertionError} Ném lỗi khi các điều kiện so sánh độ lớn nhu cầu bị sai lệch.
 */
test('deterministic demand models weekly/hourly rhythm, growth and events', () => {
  // Bước 1: Kiểm tra mốc bắt đầu tính dữ liệu (WINDOW_START) và tính tất định của hàm random (cùng seed sinh cùng giá trị)
  assert.equal(WINDOW_START, '2026-09-01');
  assert.equal(random('noise:day'), random('noise:day'));
  // Bước 2: Kiểm tra nhịp giờ trong ngày: giờ cao điểm tối (19h) > sáng sớm (7h) > giờ trưa thấp điểm (12h)
  for (const d of ['2026-10-05', '2026-10-09', '2026-10-10']) {
    assert.ok(demand(d, 19) > demand(d, 7));
    assert.ok(demand(d, 7) > demand(d, 12));
  }
  // Bước 3: Kiểm tra nhịp tuần: cuối tuần (thứ Bảy) và thứ Sáu có nhu cầu cao hơn các ngày đầu tuần (thứ Hai, thứ Ba)
  assert.ok(demand('2026-10-10', 19) > demand('2026-10-05', 19));
  assert.ok(demand('2026-10-09', 19) > demand('2026-10-06', 19));
  // Bước 4: Kiểm tra sự kiện đặc biệt: ngày lễ Quốc khánh 2/9 và Phụ nữ Việt Nam 20/10 có hệ số nhu cầu tăng vọt so với ngày thường
  assert.ok(demand('2026-09-02', 19) > demand('2026-09-09', 19));
  assert.ok(demand('2026-10-20', 19) > demand('2026-10-06', 19));
  // Tuần lễ cao điểm (12/10 - 18/10) có nhu cầu cao hơn tuần thường, trong khi tuần bảo trì (26/10 - 01/11) bị giảm mạnh
  assert.ok(demand('2026-10-14', 19) > demand('2026-10-07', 19));
  assert.ok(demand('2026-10-28', 19) < demand('2026-10-07', 19));
  // Bước 5: Kiểm tra hiệu ứng tăng trưởng tự nhiên theo thời gian: ngày càng về sau nhu cầu càng tăng nhờ hệ số tuổi hệ thống (age factor)
  assert.ok(demand('2026-11-04', 19) > demand('2026-09-09', 19));
});

/**
 * Làm gì: Kiểm tra các rào chắn bảo vệ database production (chặn URL từ xa, chặn override host) và chính sách nhận diện/bảo vệ tài khoản demo cốt lõi.
 * Được gọi ở: test runner (node --test).
 * @returns {void} Không trả về giá trị, ném AssertionError nếu rào chắn bảo vệ bị lọt hoặc nhận diện sai tài khoản.
 * @throws {AssertionError} Ném lỗi khi các hàm kiểm tra writableTarget, normalize, protectedLogin hoặc suspiciousUser chạy sai.
 */
test('production guards and protected demo identities', () => {
  // Bước 1: Kiểm tra rào chắn bảo vệ production: chặn ghi đè trực tiếp database từ xa (Neon/Postgres ngoài localhost) và chặn lách bằng query param host override
  for (const url of ['postgres://u:p@ep-demo.neon.tech/db', 'postgres://u:p@db.example.com/db',
    'postgres://u:p@localhost/db?host=ep-prod.neon.tech'])
    assert.throws(() => writableTarget(url), /blocked/);
  // Bước 2: Kiểm tra đường dẫn thư mục PGlite local: bắt buộc phải truyền thư mục đĩa riêng biệt, cấm thư mục rỗng hoặc chạy trên memory
  assert.throws(() => writableTarget('', ''), /dedicated/);
  assert.throws(() => writableTarget('', 'memory'), /dedicated/);
  assert.doesNotThrow(() => writableTarget('', '.cache/lively-test'));
  // Bước 3: Kiểm tra cơ chế xác nhận ghi đè remote có chủ đích: bắt buộc cờ --replace-remote phải khớp chính xác hostname mục tiêu
  assert.throws(() => writableTarget('postgres://u:p@ep-demo.neon.tech/db', '', 'wrong-host'), /hostname/);
  assert.doesNotThrow(() => writableTarget('postgres://u:p@ep-demo.neon.tech/db', '', 'ep-demo.neon.tech'));
  // Bước 4: Kiểm tra tiện ích chuẩn hóa chuỗi tiếng Việt (bỏ dấu) và hàm sinh UUID cố định theo key
  assert.equal(normalize('Đặng Thị Bảo Ngọc'), 'dang thi bao ngoc');
  assert.equal(id('member:1'), id('member:1'));
  // Bước 5: Kiểm tra chính sách bảo vệ tài khoản: các tài khoản domain nội bộ (@arena3.local) và số hotline cố định không bao giờ bị coi là user rác
  for (const u of [{ full_name: 'Coach Test 12345', email: 'coach@arena3.local' },
    { full_name: 'Coach Check 5319583', phone: '+84900000002' }]) {
    assert.ok(protectedLogin(u)); assert.equal(suspiciousUser(u), false);
  }
  // Nhận diện người dùng rác/test dựa trên tên chứa từ khóa (coach, test, dummy...), chuỗi số ngẫu nhiên hoặc lỗi mã hóa ký tự
  assert.ok(suspiciousUser({ full_name: 'Coach Swim 9048569' }));
  assert.equal(suspiciousUser({ full_name: 'Nguyễn Minh Khoa' }), false);
});

/**
 * Làm gì: Kiểm tra tính bền vững của dữ liệu PGlite trên Windows khi đóng và mở lại kết nối, đảm bảo prepareLocalDirectory xử lý triệt để thuộc tính ReadOnly.
 * Được gọi ở: test runner (node --test).
 * @returns {Promise<void>} Không trả về giá trị, ném AssertionError nếu dữ liệu bị mất sau khi mở lại thư mục.
 * @throws {AssertionError} Ném lỗi khi không tìm thấy hoặc giá trị đọc lại không khớp với dữ liệu đã lưu.
 */
test('PGlite directory survives close and reopen on Windows', async () => {
  // Bước 1: Tạo thư mục dữ liệu tạm thời trong .cache để thực hiện kiểm thử tính bền vững
  await mkdir('.cache', { recursive: true });
  const dir = await mkdtemp(resolve('.cache', 'lively-persistence-'));
  // Bước 2: Chuẩn bị quyền thư mục, khởi tạo instance PGlite đầu tiên, tạo bảng và chèn dữ liệu mẫu
  await prepareLocalDirectory(dir);
  const first = new PGlite({ dataDir: dir });
  await first.exec('create table persistence_probe(value int); insert into persistence_probe values(42)');
  // Bước 3: Đóng kết nối phiên đầu tiên và chạy lại prepareLocalDirectory để xử lý quyền thư mục trên Windows (tránh lỗi ReadOnly)
  await first.close();
  await prepareLocalDirectory(dir);
  // Bước 4: Mở lại kết nối từ cùng thư mục dữ liệu và xác nhận dữ liệu đã chèn trước đó vẫn tồn tại nguyên vẹn
  const second = new PGlite({ dataDir: dir });
  try { assert.equal((await second.query('select value from persistence_probe')).rows[0].value, 42); }
  finally { await second.close(); }
});

/**
 * Làm gì: Kiểm thử tích hợp toàn diện: chạy migration thực tế, kiểm tra tính tất định khi tạo dữ liệu (idempotency), bảo toàn tài khoản gốc, kiểm tra các bất biến nghiệp vụ và khả năng rollback.
 * Được gọi ở: test runner (node --test).
 * @returns {Promise<void>} Không trả về giá trị, ném AssertionError nếu bất kỳ điều kiện kiểm tra nghiệp vụ hoặc kiểm thử tích hợp thất bại.
 * @throws {AssertionError} Ném lỗi khi vi phạm bất biến dữ liệu, trùng lịch hoặc dữ liệu không nhất quán.
 */
test('real migrations, financial/schedule invariants, rerun idempotency and rollback', { timeout: 180000 }, async () => {
  // Cấu hình parser cho PGlite: mã 1082 (DATE) giữ nguyên chuỗi YYYY-MM-DD tránh lệch múi giờ, mã 20 (BIGINT) ép kiểu về Number
  const db = new PGlite({ parsers: { 1082: s => s, 20: Number } });
  try {
    // Bước 1: Chạy tất cả migration từ thư mục migrations/ để dựng schema cơ sở dữ liệu hoàn chỉnh
    await migrate(db);
    // Bước 2: Lưu lại danh sách tài khoản người dùng ban đầu để sau khi seed đối soát xem có bị ghi đè hoặc mất mát không
    const logins = (await db.query('select id, phone, email, password_hash, google_sub from users order by id')).rows;
    const asOf = '2026-11-09T16:00:00.000Z';
    /**
     * Làm gì: Xóa sạch dữ liệu activity, chạy hàm populate() để sinh dữ liệu seed tại mốc thời gian asOf và tạo bảng mã băm MD5 của từng bảng activity để kiểm tra tính tất định.
     * Được gọi ở: test runner (node --test), bên trong test tích hợp tại dòng 89 và 90.
     * @returns {Promise<Record<string, string>>} Đối tượng ánh xạ tên bảng activity sang chuỗi MD5 hash của toàn bộ các dòng dữ liệu.
     */
    const snapshot = async () => {
      // Xóa sạch dữ liệu activity cũ và reset lại sequence khóa chính trước khi tạo mới
      await db.exec(`truncate table ${ACTIVITY.join(',')} restart identity`);
      const report = await populate(db, asOf);
      // Kiểm tra số lượng bản ghi mẫu sinh ra đạt quy mô thực tế (hơn 5000 lượt đặt sân, trên 3000 tin nhắn...)
      assert.ok(report.added.court_bookings > 5000);
      assert.ok(report.added.users === 0 || report.added.users > 50 && report.added.users <= 96);
      assert.equal(report.from, WINDOW_START);
      assert.ok(report.added.conversations >= 200);
      assert.ok(report.added.messages >= 3000);
      assert.ok(report.added.promotion_redemptions > 0);
      // Chạy bộ quy tắc kiểm tra bất biến verify() với hơn 38 câu query đối soát toàn diện nghiệp vụ
      const verification = await verify(db, asOf);
      assert.ok(verification.checks >= 38);
      assert.deepEqual(verification.failures, {});
      const result = {};
      // Tạo chữ ký số MD5 gom toàn bộ dòng dữ liệu JSON có sắp xếp của từng bảng để so sánh tính nhất quán giữa các lần seed
      for (const t of ACTIVITY) result[t] = (await db.query(`select md5(coalesce(string_agg(row_to_json(r)::text, '|' order by row_to_json(r)::text),'')) hash from ${t} r`)).rows[0].hash;
      return result;
    };
    // Bước 3: Chạy snapshot lần đầu và lần hai với cùng mốc thời gian asOf, xác minh dữ liệu sinh ra phải trùng khớp tuyệt đối (tính tất định)
    const first = await snapshot();
    assert.deepEqual(await snapshot(), first, 'same as-of must produce exactly the same activity rows');
    /**
     * Làm gì: Thực thi một câu lệnh SQL tổng hợp (aggregate query) và lấy giá trị số nguyên từ cột kết quả 'n'.
     * Được gọi ở: test runner (node --test), các bước kiểm tra số lượng bản ghi trong test tích hợp.
     * @param {string} sql Câu lệnh SQL trả về một cột kết quả có alias là 'n'.
     * @returns {Promise<number>} Giá trị số nguyên tương ứng trong cột 'n'.
     */
    const scalar = async sql => Number((await db.query(sql)).rows[0].n);
    // Bước 4: Kiểm tra sự đa dạng của các phương thức thanh toán trong hệ thống (thẻ, tiền mặt, cổng thanh toán, chuyển khoản)
    const methods = (await db.query('select distinct method::text method from payments order by 1')).rows.map(r => r.method);
    assert.deepEqual(methods, ['card', 'cash', 'gateway', 'transfer']);
    // Bước 5: Tổng hợp doanh thu theo từng thứ trong tuần của tháng 10/2026 theo múi giờ Việt Nam (+07:00)
    const weekdays = (await db.query(`select extract(isodow from paid_at at time zone 'Asia/Ho_Chi_Minh')::int weekday,
      sum(amount_vnd)::bigint revenue from payments where paid_at>='2026-10-01T00:00:00+07:00'
      and paid_at<'2026-11-01T00:00:00+07:00' and status='posted' group by 1`)).rows;
    /**
     * Làm gì: Tính doanh thu trung bình mỗi ngày theo thứ trong tuần trong tháng 10/2026, chia theo số lần xuất hiện thực tế của thứ đó trong tháng.
     * Được gọi ở: test runner (node --test), kiểm tra so sánh doanh thu các ngày cuối tuần và trong tuần.
     * @param {number} d Thứ trong tuần theo chuẩn ISO (1 = Thứ Hai, ..., 7 = Chủ Nhật).
     * @returns {number} Doanh thu trung bình theo ngày (VND).
     */
    const avg = d => Number(weekdays.find(r => r.weekday === d).revenue) / ([4,4,4,5,5,5,4][d - 1]);
    // Mảng [4,4,4,5,5,5,4] tương ứng số ngày T2, T3, T4, T5, T6, T7, CN trong tháng 10/2026; doanh thu các ngày cuối tuần và thứ Sáu phải cao nhất
    for (const d of [1, 2]) for (const busy of [3, 4, 5, 6, 7]) assert.ok(avg(busy) > avg(d), `weekday ${busy} should beat ${d}`);
    assert.ok(avg(6) > avg(5) && avg(7) > avg(5), 'weekends have the highest average daily revenue');
    /**
     * Làm gì: Đếm tổng số lượt đặt sân (court_bookings) diễn ra trong một ngày cụ thể theo múi giờ Việt Nam (+07:00).
     * Được gọi ở: test runner (node --test), kiểm tra biến động lượng đặt sân giữa các ngày lễ và ngày thường.
     * @param {string} date Ngày cần kiểm tra theo định dạng YYYY-MM-DD.
     * @returns {Promise<number>} Tổng số lượt đặt sân trong ngày đó.
     */
    const bookingsOn = date => scalar(`select count(*) n from court_bookings where (start_at at time zone 'Asia/Ho_Chi_Minh')::date='${date}'`);
    // Bước 6: Kiểm tra lượng đặt sân thực tế trong database phản ánh đúng các sự kiện đặc biệt (Quốc khánh 2/9, 20/10, tuần bảo trì)
    assert.ok(await bookingsOn('2026-09-02') > await bookingsOn('2026-09-09'));
    assert.ok(await bookingsOn('2026-10-20') > await bookingsOn('2026-10-06'));
    assert.ok(await bookingsOn('2026-10-28') < await bookingsOn('2026-10-07'));
    // Bước 7: Kiểm tra tính chân thực của dữ liệu hoạt động: hoàn tiền (amount_vnd < 0), tin nhắn chưa đọc/đã đọc, audit logs, tickets và outbox
    assert.ok(await scalar(`select count(distinct (paid_at at time zone 'Asia/Ho_Chi_Minh')::date) n from payments where amount_vnd<0`) > 30);
    assert.ok(await scalar(`select count(*) n from messages where read_at is null`) > 50);
    assert.ok(await scalar(`select count(*) n from messages where read_at is not null`) > 1000);
    assert.ok(await scalar(`select count(distinct action) n from audit_logs`) >= 14);
    assert.ok(await scalar(`select count(*) n from tickets where status='open'`) > 10);
    assert.ok(await scalar(`select count(*) n from tickets where status='closed' and reply is null`) > 0);
    assert.ok(await scalar(`select count(*) n from outbox where read_at is null and sent_at is not null`) > 20);
    /**
     * Làm gì: Đếm số lượng hội viên duy nhất (distinct user_id) đã kích hoạt gói tập tính đến trước hoặc trong ngày chỉ định.
     * Được gọi ở: test runner (node --test), kiểm tra xu hướng tăng trưởng hội viên theo thời gian.
     * @param {string} date Ngày mốc cần kiểm tra theo định dạng YYYY-MM-DD.
     * @returns {Promise<number>} Tổng số hội viên duy nhất đã đăng ký gói tập.
     */
    const joinedBy = date => scalar(`select count(distinct user_id) n from subscriptions where start_on<='${date}'`);
    // Bước 8: Kiểm tra quy luật tăng trưởng số lượng hội viên đăng ký gói tập theo thời gian
    assert.ok(await joinedBy('2026-11-09') > await joinedBy('2026-10-01'));
    assert.ok(await joinedBy('2026-10-01') > await joinedBy('2026-09-10'));
    // Bước 9: Kiểm tra tính toàn vẹn của tài khoản người dùng: toàn bộ tài khoản ban đầu phải được giữ nguyên vẹn thông tin nhạy cảm
    const seededCount = Number((await db.query("select count(*) n from users where email like 'lively.%@example.invalid'")).rows[0].n);
    assert.equal(Number((await db.query('select count(*) n from users')).rows[0].n), logins.length + seededCount);
    for (const u of logins) assert.deepEqual((await db.query('select id, phone, email, password_hash, google_sub from users where id=$1', [u.id])).rows[0], u);
    // Bước 10: Xác minh trigger/ràng buộc chống đặt trùng sân (CONFLICT_SLOT) trên bảng occupancies vẫn hoạt động khi chèn lịch trùng khung giờ
    // The DB's overlap protection stays enabled.
    await db.exec('begin');
    const occ = (await db.query(`insert into occupancies(court_id,start_at,end_at,kind,ref_id)
      select court_id,start_at,end_at,'booking',id from court_bookings limit 1 returning *`)).rows[0];
    await assert.rejects(db.query('insert into occupancies(court_id,start_at,end_at,kind,ref_id) values($1,$2,$3,$4,$5)',
      [occ.court_id, occ.start_at, occ.end_at, 'booking', id('deliberate-conflict')]), /CONFLICT_SLOT/);
    await db.exec('rollback');
    // Bước 11: Kiểm tra tính phòng vệ khi truyền mốc thời gian không hợp lệ vào populate(), giao dịch phải rollback an toàn
    await db.exec('begin');
    await db.exec(`truncate table ${ACTIVITY.join(',')} restart identity`);
    await assert.rejects(populate(db, 'invalid'), /Invalid/);
    await db.exec('rollback');
    assert.deepEqual((await verify(db, asOf)).failures, {});
    // Bước 12: Kiểm tra hàm verify() thực sự phát hiện vi phạm nghiệp vụ khi dữ liệu bị sai lệch
    // Verify the verifier detects bad new data, rather than only counting checks.
    await db.exec('begin');
    await db.query('update messages set read_at=$1 where id=(select id from messages limit 1)', ['2027-01-01T00:00:00Z']);
    await assert.rejects(verify(db, asOf), /messageWindow/);
    await db.exec('rollback');
    // Bước 13: Kiểm tra các mốc cutoff khác nhau: không được tạo bất kỳ dữ liệu nào sau mốc cutoff tương ứng
    // Early and partial days must not mint activity after their cutoff, even on a rerun.
    for (const cutoff of ['2026-08-31T17:00:00Z', '2026-09-01T05:00:00Z', '2026-09-11T18:00:00Z',
      '2026-10-12T18:00:00Z', '2026-11-09T05:30:00Z']) {
      await db.exec('begin');
      await db.exec(`truncate table ${ACTIVITY.join(',')} restart identity`);
      await populate(db, cutoff);
      assert.deepEqual((await verify(db, cutoff)).failures, {}, cutoff);
      await db.exec('rollback');
    }
    // Mốc thời gian trước ngày khởi tạo WINDOW_START (2026-09-01 00:00 ICT = 2026-08-31 17:00 UTC) phải bị từ chối
    await assert.rejects(populate(db, '2026-08-31T16:59:59Z'), /precedes/);
  } finally { await db.close(); }
});
