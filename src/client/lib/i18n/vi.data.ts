/**
 * Demo/seed content that lives in the database in English (migration 0010). Shown through
 * `tData()` so the Vietnamese UI doesn't mix in English plan names, gear and health notes.
 * Only exact matches are translated; anything a person typed is shown as written.
 */
export const VI_DATA_EXACT: Record<string, string> = {
  "Trial (hidden)": "Học thử (ẩn)",
  "Badminton racket": "Vợt cầu lông",
  "Shuttle tube": "Ống cầu lông",
  Basketball: "Bóng rổ",
  Volleyball: "Bóng chuyền",
  "Lê Long Sport Manager": "Quản lý Lê Long Sport",
  "Front Desk 1": "Lễ tân 1",
  "Front Desk 2": "Lễ tân 2",
  "Coach Minh Quan": "HLV Minh Quân",
  "Minor — guardian consent on file": "Dưới 18 tuổi, đã có giấy đồng ý của phụ huynh",
  "Badminton coach — old left-shoulder injury, avoid heavy smash loads": "Huấn luyện viên cầu lông, chấn thương vai trái cũ, tránh đập cầu mạnh",
  "Goal: lose weight. New to badminton": "Mục tiêu: giảm cân. Mới chơi cầu lông",
  "Right knee pain after long runs": "Đau đầu gối phải sau khi chạy dài",
  "Advanced badminton, prepping for the in-house tournament": "Cầu lông nâng cao, đang chuẩn bị cho giải nội bộ",
  "Intermediate basketball": "Bóng rổ trình độ trung bình",
  "New to volleyball": "Mới chơi bóng chuyền",
  "Lê Long Sport": "Lê Long Sport",
  "Ho Chi Minh City": "TP. Hồ Chí Minh",
};

const SPORT: Record<string, string> = { Badminton: "Cầu lông", Basketball: "Bóng rổ", Volleyball: "Bóng chuyền", "All-access": "Toàn bộ môn" };
const PLAN = /^(Badminton|Basketball|Volleyball|All-access) (\d+) (days|sessions)$/;

export function viData(s: string): string {
  const exact = VI_DATA_EXACT[s];
  if (exact) return exact;
  const m = PLAN.exec(s);
  return m ? `${SPORT[m[1]!]} ${m[2]} ${m[3] === "days" ? "ngày" : "buổi"}` : s;
}
