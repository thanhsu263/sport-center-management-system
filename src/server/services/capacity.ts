/**
 * Quản lý tính toán công suất sử dụng sân (court capacity) và tỷ lệ lấp đầy.
 * File này xử lý việc tổng hợp dữ liệu số phút đã bán (sold_min) so với số phút mở cửa (open_min),
 * phân tích ma trận theo từng khung giờ, từng sân, môn thể thao và phân loại giờ cao điểm/thấp điểm,
 * phục vụ trực tiếp cho báo cáo công suất sân của ban quản lý (FR-CRT-09) trong reports.ts.
 */
export type CapacityCell = {
  court_id: string;
  court_code: string;
  sport: string;
  hr: number;
  slots: number;
  sold_min: number;
  days_booked: number;
  days_total: number;
};

/**
 * Làm gì: Tính tỷ lệ phần trăm (percentage) giữa tử số và mẫu số, làm tròn đến 1 chữ số thập phân (ví dụ: 85.5%). Tránh chia cho 0 khi mẫu số bằng 0.
 * Được gọi ở: services/capacity.ts (groupCapacity, summarizeCapacity), handlers/reports.ts (capacityBody, membersReportBody, summaryRow).
 * @param num Tử số (ví dụ: số phút đã bán, số lượng đã đăng ký).
 * @param den Mẫu số (ví dụ: tổng số phút mở cửa, sức chứa tối đa).
 * @returns Tỷ lệ phần trăm làm tròn đến 1 chữ số thập phân (number), trả về 0 nếu den <= 0.
 * @throws Không ném lỗi.
 */
export const pct1 = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

type PeakRule = { sport: string; start_min: number; end_min: number };

/**
 * Làm gì: Tạo hàm kiểm tra (predicate) có bộ nhớ đệm (cache) để xác định một khung giờ của môn thể thao có phải giờ cao điểm (peak) hay không.
 * Được gọi ở: services/capacity.ts (hàm groupCapacity).
 * @param rules Danh sách quy tắc giờ cao điểm (PeakRule) lấy từ bảng price_rules (các bản ghi có is_peak = true).
 * @returns Hàm nhận (sport, hour) và trả về boolean (true nếu là giờ cao điểm của môn thể thao đó).
 * @throws Không ném lỗi.
 */
function peakHoursFor(rules: PeakRule[]) {
  // Bước 1: Khởi tạo Map 2 cấp (sport -> hour -> boolean) làm bộ nhớ đệm (memoization) tránh duyệt lại rules nhiều lần.
  const bySport = new Map<string, Map<number, boolean>>();
  // Bước 2: Trả về closure kiểm tra khung giờ; tính toán khi gặp giờ mới và lưu vào cache.
  return (sport: string, hour: number) => {
    let hours = bySport.get(sport);
    if (!hours) {
      hours = new Map();
      bySport.set(sport, hours);
    }
    if (!hours.has(hour)) {
      // Quy đổi giờ sang phút trong ngày (0 - 1440) để so khớp với khoảng [start_min, end_min) trong price_rules.
      const minute = hour * 60;
      hours.set(hour, rules.some((rule) => rule.sport === sport && rule.start_min <= minute && rule.end_min > minute));
    }
    return hours.get(hour)!;
  };
}

/**
 * Làm gì: Gom nhóm và cộng dồn dữ liệu công suất theo 3 chiều: từng sân (byCourt), từng môn thể thao (bySport kèm phân bổ peak/off-peak), và từng khung giờ (byHour).
 * Được gọi ở: services/capacity.ts (hàm summarizeCapacity).
 * @param cells Danh sách các ô công suất chi tiết (CapacityCell) được truy vấn từ database.
 * @param rules Danh sách quy tắc giờ cao điểm (PeakRule) dùng để phân loại số phút cao điểm / thấp điểm.
 * @returns Đối tượng chứa 3 Map tổng hợp: byCourt, bySport và byHour.
 * @throws Không ném lỗi.
 */
function groupCapacity(cells: CapacityCell[], rules: PeakRule[]) {
  // Bước 1: Khởi tạo hàm kiểm tra giờ cao điểm và các Map lưu trữ tổng hợp theo sân, môn thể thao, khung giờ.
  const isPeak = peakHoursFor(rules);

  const byCourt = new Map<
    string,
    {
      court_code: string;
      sport: string;
      sold: number;
      open: number;
      cells: Map<number, number>;
      days_booked: Map<number, number>;
    }
  >();
  const bySport = new Map<string, { sold: number; open: number; peakSold: number; peakOpen: number; offSold: number; offOpen: number }>();
  const byHour = new Map<number, { sold: number; open: number }>();
  // Bước 2: Duyệt qua từng ô công suất để cộng dồn số phút bán/mở và phân loại theo từng chiều báo cáo.
  for (const c of cells) {
    // Mỗi slot đại diện cho 1 giờ mở cửa của sân trong ngày, quy đổi ra 60 phút khả dụng.
    const open = c.slots * 60;
    // Cộng dồn số phút bán/mở cho từng sân và lưu tỷ lệ % lấp đầy, số ngày có đặt sân theo khung giờ c.hr.
    const court = byCourt.get(c.court_id) ?? {
      court_code: c.court_code,
      sport: c.sport,
      sold: 0,
      open: 0,
      cells: new Map(),
      days_booked: new Map(),
    };
    court.sold += c.sold_min;
    court.open += open;
    court.cells.set(c.hr, pct1(c.sold_min, open));
    court.days_booked.set(c.hr, c.days_booked);
    byCourt.set(c.court_id, court);
    // Phân bổ số phút bán và mở của môn thể thao vào nhóm giờ cao điểm (peak) hoặc thấp điểm (off-peak).
    const sp = bySport.get(c.sport) ?? { sold: 0, open: 0, peakSold: 0, peakOpen: 0, offSold: 0, offOpen: 0 };
    sp.sold += c.sold_min;
    sp.open += open;
    if (isPeak(c.sport, c.hr)) {
      sp.peakSold += c.sold_min;
      sp.peakOpen += open;
    } else {
      sp.offSold += c.sold_min;
      sp.offOpen += open;
    }
    bySport.set(c.sport, sp);
    // Cộng dồn toàn bộ số phút bán và mở bán ở khung giờ c.hr trên tất cả các sân.
    const hh = byHour.get(c.hr) ?? { sold: 0, open: 0 };
    hh.sold += c.sold_min;
    hh.open += open;
    byHour.set(c.hr, hh);
  }
  // Bước 3: Trả về kết quả gom nhóm 3 chiều (theo sân, theo môn, theo khung giờ).
  return { byCourt, bySport, byHour };
}

/**
 * Làm gì: Tổng hợp báo cáo công suất sân; tạo ma trận giờ liên tục từ openHour đến closeHour, tính tỷ lệ lấp đầy cho từng sân và tổng hợp toàn trung tâm.
 * Được gọi ở: handlers/reports.ts (hàm capacityBody, phục vụ route GET /api/reports/capacity và GET /api/manager/capacity).
 * @param cells Mảng các ô dữ liệu công suất chi tiết (CapacityCell) nạp từ cơ sở dữ liệu.
 * @param rules Danh sách quy tắc giờ cao điểm (PeakRule) lấy từ bảng price_rules.
 * @param openHour Giờ mở cửa của trung tâm theo cài đặt hệ thống (ví dụ: 6 là 06:00).
 * @param closeHour Giờ đóng cửa của trung tâm theo cài đặt hệ thống (ví dụ: 22 là 22:00).
 * @param daysTotal Tổng số ngày trong chu kỳ báo cáo (dùng để hiển thị mẫu số cho số ngày đã đặt).
 * @returns Đối tượng tổng hợp gồm mảng hours, danh sách courts (kèm cell_details), tổng toàn trung tâm all, bySport và byHour.
 * @throws Không ném lỗi.
 */
export function summarizeCapacity(cells: CapacityCell[], rules: PeakRule[], openHour: number, closeHour: number, daysTotal: number) {
  // Bước 1: Sinh mảng các mốc giờ hoạt động liên tục [openHour, closeHour) để lấp đầy ma trận báo cáo không bị ngắt quãng.
  const hours = Array.from({ length: Math.max(0, closeHour - openHour) }, (_, i) => openHour + i);
  // Bước 2: Gom nhóm dữ liệu công suất theo sân, môn thể thao và từng khung giờ.
  const { byCourt, bySport, byHour } = groupCapacity(cells, rules);
  // Bước 3: Chuyển đổi dữ liệu từng sân thành mảng, điền 0 cho những khung giờ sân không hoạt động hoặc không có lịch.
  const courts = [...byCourt.entries()].map(([court_id, c]) => ({
    court_id,
    court_code: c.court_code,
    sport: c.sport,
    sold_min: c.sold,
    open_min: c.open,
    pct: pct1(c.sold, c.open),
    cells: hours.map((h) => c.cells.get(h) ?? 0),
    days_booked: hours.map((h) => c.days_booked.get(h) ?? 0),
    days_total: daysTotal,
    cell_details: hours.map((h) => ({
      hr: h,
      pct: c.cells.get(h) ?? 0,
      days_booked: c.days_booked.get(h) ?? 0,
      days_total: daysTotal,
    })),
  }));
  // Bước 4: Cộng dồn tổng số phút đã bán và tổng số phút mở cửa của tất cả các sân để tính chỉ số toàn trung tâm.
  const all = courts.reduce((a, c) => ({ sold: a.sold + c.sold_min, open: a.open + c.open_min }), { sold: 0, open: 0 });
  // Bước 5: Trả về cấu trúc dữ liệu hoàn chỉnh cho giao diện báo cáo.
  return { hours, courts, all, bySport, byHour };
}
