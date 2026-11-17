/**
 * Tệp này định nghĩa kiểu dữ liệu CoachCard và danh sách huấn luyện viên mẫu (COACHES) của hệ thống Arena 3.
 * Vai trò trong ứng dụng:
 * - Thuộc tầng shared: dùng chung giữa client và server cho dữ liệu giới thiệu tĩnh, không lưu bảng riêng trong cơ sở dữ liệu.
 * - Phía Client: component CoachesScene (src/client/components/landing/coaches.tsx) dùng để hiển thị thẻ giới thiệu HLV trên Landing Page.
 * - Phía Server: handler ops (src/server/controllers/handlers/ops.ts) dùng làm dữ liệu ngữ cảnh (grounding facts) cho trợ lý AI Gemini trả lời câu hỏi của hội viên.
 * - Quản lý media: liên kết với slot ảnh đại diện (coach.<userId>) được định nghĩa trong MEDIA_REGISTRY.
 */
export type CoachCard = {
  name: string;
  sport?: string;
  title: string;
  blurb: string;
  creds: string[];
  userId?: string;
  slot?: string;
};

/** Presentation copy for the seeded coaches — not a new table. */
/**
 * Làm gì: Mảng chứa thông tin giới thiệu của 4 huấn luyện viên trưởng mặc định (seeded coaches) cho các bộ môn cầu lông, bóng rổ và bóng chuyền.
 * Được gọi ở: src/client/components/landing/coaches.tsx (component CoachesScene) và src/server/controllers/handlers/ops.ts (trợ lý AI Gemini).
 */
export const COACHES: CoachCard[] = [
  {
    name: "Nguyễn Minh Khoa",
    title: "Head badminton coach",
    blurb:
      "Runs the beginner and advanced ladders. Footwork first, controlled smashes second. No shoulders burned out in week one.",
    creds: ["Beginner Mon/Wed/Fri 18:00", "Advanced Sat 08:00"],
    userId: "00000000-0000-0000-0000-000000000011",
    slot: "coach.00000000-0000-0000-0000-000000000011",
  },
  {
    name: "Trần Thị Lan",
    title: "Intermediate badminton coach",
    blurb:
      "Assists the beginner ladder, owns intermediate. Patient with players moving from casual rallies to a real training plan.",
    creds: ["Intermediate Tue/Thu 19:00", "Beginner assistant"],
    userId: "00000000-0000-0000-0000-000000000012",
    slot: "coach.00000000-0000-0000-0000-000000000012",
  },
  {
    name: "Phạm Đức Anh",
    title: "Head basketball coach",
    blurb:
      "Beginner basketball program: footwork, release, reading the floor. Classes never sit on a sold slot.",
    creds: ["Beginner Mon/Wed 17:00", "Vertical · coordination"],
    userId: "00000000-0000-0000-0000-000000000013",
    slot: "coach.00000000-0000-0000-0000-000000000013",
  },
  {
    name: "Lê Quốc Việt",
    title: "Head volleyball coach",
    blurb:
      "Intermediate volleyball: digs, serves and team reading, built for players moving off the sand into a structured side.",
    creds: ["Intermediate Sat 16:00", "Rotations · reflexes"],
    userId: "00000000-0000-0000-0000-000000000014",
    slot: "coach.00000000-0000-0000-0000-000000000014",
  },
];
