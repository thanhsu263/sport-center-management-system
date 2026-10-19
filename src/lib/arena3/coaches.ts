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
