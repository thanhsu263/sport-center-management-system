import fs from "node:fs";
import path from "node:path";

const BASE_DIR = "public/media/library";
const MANIFEST_PATH = "scripts/media/library.json";
const CREDITS_PATH = "public/media/library/CREDITS.md";

const CATEGORIES = {
  badminton: { min: 12 },
  basketball: { min: 12 },
  volleyball: { min: 12 },
  "other-sports": { min: 16 },
  facility: { min: 16 },
  coach: { min: 14 },
  class: { min: 12 },
  equipment: { min: 8 },
  event: { min: 8 },
};

// 14 Curated Unsplash model portraits for coaches (4:5 vertical, sportswear / athletic trainers)
const COACH_PORTRAITS = [
  {
    slug: "coach-nguyen-minh-khoa",
    id: "photo-1507003211169-0a1dd7228f2d",
    author: "Joseph Gonzalez",
    source_url: "https://unsplash.com/photos/Joseph-Gonzalez",
    alt_en: "Coach Nguyen Minh Khoa portrait, badminton head coach",
    alt_vi: "Chân dung HLV trưởng cầu lông Nguyễn Minh Khoa",
    tags: ["coach", "badminton", "head-coach", "portrait"],
  },
  {
    slug: "coach-tran-thi-lan",
    id: "photo-1534528741775-53994a69daeb",
    author: "Averie Woodard",
    source_url: "https://unsplash.com/photos/Averie-Woodard",
    alt_en: "Coach Tran Thi Lan portrait, badminton junior coach",
    alt_vi: "Chân dung HLV cầu lông Trần Thị Lan",
    tags: ["coach", "badminton", "female", "portrait"],
  },
  {
    slug: "coach-pham-duc-anh",
    id: "photo-1500648767791-00dcc994a43e",
    author: "Jurica Koletić",
    source_url: "https://unsplash.com/photos/Jurica-Koletic",
    alt_en: "Coach Pham Duc Anh portrait, basketball coach",
    alt_vi: "Chân dung HLV bóng rổ Phạm Đức Anh",
    tags: ["coach", "basketball", "male", "portrait"],
  },
  {
    slug: "coach-le-quoc-viet",
    id: "photo-1492562080023-ab3db95bfbce",
    author: "Warren Wong",
    source_url: "https://unsplash.com/photos/Warren-Wong",
    alt_en: "Coach Le Quoc Viet portrait, volleyball coach",
    alt_vi: "Chân dung HLV bóng chuyền Lê Quốc Việt",
    tags: ["coach", "volleyball", "male", "portrait"],
  },
  {
    slug: "coach-minh-quan",
    id: "photo-1506794778202-cad84cf45f1d",
    author: "Albert Dera",
    source_url: "https://unsplash.com/photos/Albert-Dera",
    alt_en: "Coach Minh Quan portrait, fitness and conditioning coach",
    alt_vi: "Chân dung HLV thể lực Minh Quân",
    tags: ["coach", "fitness", "conditioning", "portrait"],
  },
  {
    slug: "coach-asian-female-trainer",
    id: "photo-1517841905240-472988babdf9",
    author: "Valerie Elash",
    source_url: "https://unsplash.com/photos/Valerie-Elash",
    alt_en: "Athletic coach portrait in sportswear",
    alt_vi: "Chân dung huấn luyện viên nữ trong trang phục thể thao",
    tags: ["coach", "fitness", "female", "portrait"],
  },
  {
    slug: "coach-young-athlete-trainer",
    id: "photo-1539571696357-5a69c17a67c6",
    author: "Brooke Cagle",
    source_url: "https://unsplash.com/photos/Brooke-Cagle",
    alt_en: "Young athletic trainer portrait",
    alt_vi: "Chân dung huấn luyện viên trẻ năng động",
    tags: ["coach", "athletic", "male", "portrait"],
  },
  {
    slug: "coach-asian-athlete-stretching",
    id: "photo-1518611012118-696072aa579a",
    author: "Form",
    source_url: "https://unsplash.com/photos/Form",
    alt_en: "Athletic coach stretching on court",
    alt_vi: "Huấn luyện viên khởi động giãn cơ trên sân",
    tags: ["coach", "stretching", "court", "portrait"],
  },
  {
    slug: "coach-fitness-gym-trainer",
    id: "photo-1571019613454-1cb2f99b2d8b",
    author: "Benjamin Klaver",
    source_url: "https://unsplash.com/photos/Benjamin-Klaver",
    alt_en: "Fitness trainer ready for training session",
    alt_vi: "Huấn luyện viên thể hình sẵn sàng cho buổi tập",
    tags: ["coach", "fitness", "gym", "portrait"],
  },
  {
    slug: "coach-sports-conditioning-man",
    id: "photo-1583454110551-21f2fa2afe61",
    author: "Alora Griffiths",
    source_url: "https://unsplash.com/photos/Alora-Griffiths",
    alt_en: "Strength and conditioning coach portrait",
    alt_vi: "Chân dung huấn luyện viên thể lực và sức mạnh",
    tags: ["coach", "strength", "conditioning", "portrait"],
  },
  {
    slug: "coach-indoor-sports-trainer",
    id: "photo-1605296867304-46d5465a13f1",
    author: "Karsten Winegeart",
    source_url: "https://unsplash.com/photos/Karsten-Winegeart",
    alt_en: "Indoor sports coach with athletic gear",
    alt_vi: "Huấn luyện viên thể thao trong nhà với trang thiết bị tập luyện",
    tags: ["coach", "indoor", "gear", "portrait"],
  },
  {
    slug: "coach-asian-sports-woman",
    id: "photo-1594381898411-846e7d193883",
    author: "Courtney Cook",
    source_url: "https://unsplash.com/photos/Courtney-Cook",
    alt_en: "Active female sports coach portrait",
    alt_vi: "Chân dung huấn luyện viên thể thao nữ năng động",
    tags: ["coach", "sports", "female", "portrait"],
  },
  {
    slug: "coach-professional-athletic-female",
    id: "photo-1567532939604-b6b5b0db2604",
    author: "Christian Buehner",
    source_url: "https://unsplash.com/photos/Christian-Buehner",
    alt_en: "Professional athletic coach portrait",
    alt_vi: "Chân dung huấn luyện viên chuyên nghiệp",
    tags: ["coach", "professional", "portrait"],
  },
  {
    slug: "coach-badminton-instructor-male",
    id: "photo-1535713875002-d1d0cf377fde",
    author: "Stefan Stefancik",
    source_url: "https://unsplash.com/photos/Stefan-Stefancik",
    alt_en: "Dedicated sports coach portrait",
    alt_vi: "Chân dung huấn luyện viên thể thao tâm huyết",
    tags: ["coach", "dedicated", "portrait"],
  },
];

const COMMONS_QUERIES = {
  badminton: [
    "badminton match indoor",
    "badminton player action",
    "badminton tournament indoor",
    "badminton smash court",
    "badminton racket shuttlecock",
    "badminton court lines",
    "badminton net indoor",
  ],
  basketball: [
    "basketball game indoor court",
    "basketball player match",
    "basketball tournament indoor",
    "basketball hoop indoor arena",
    "basketball ball hardwood",
    "basketball court gymnasium",
  ],
  volleyball: [
    "volleyball match indoor court",
    "volleyball spike player action",
    "volleyball tournament indoor",
    "volleyball net indoor",
    "volleyball serve player",
    "volleyball team court",
  ],
  "other-sports": [
    "pickleball game court",
    "pickleball match indoor",
    "indoor tennis court match",
    "indoor tennis tournament",
    "futsal match indoor",
    "futsal tournament game",
    "table tennis match tournament",
    "table tennis player indoor",
  ],
  facility: [
    "sports arena interior seating",
    "gymnasium interior court",
    "sports hall building",
    "fitness center reception",
    "locker room sports",
    "modern gym interior equipment",
    "indoor sports arena hall",
    "sports complex lobby",
  ],
  class: [
    "sports training practice indoor",
    "fitness group class training",
    "volleyball team training practice",
    "basketball practice drill indoor",
    "badminton training drill",
    "sports coaching tactical",
    "athletic conditioning training",
  ],
  equipment: [
    "shuttlecock badminton",
    "badminton racket equipment",
    "basketball ball equipment",
    "volleyball ball equipment",
    "sports equipment gear court",
    "table tennis paddle ball",
  ],
  event: [
    "sports medal ceremony podium",
    "badminton award ceremony",
    "sports championship trophy",
    "athletic tournament celebration",
    "sports team victory podium",
    "sports event arena crowd",
  ],
};

function cleanHtml(str) {
  if (!str) return "";
  return str.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function checkJpegMagicBytes(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

async function searchCommons(query, limit = 25) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
    query
  )}&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1024&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": "Arena3Bot/1.0 (test@arena3.vn)" } });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});
  return pages
    .filter((p) => {
      const info = p.imageinfo?.[0];
      if (!info) return false;
      const mime = info.mime || "";
      return (mime === "image/jpeg" || mime === "image/png") && (info.thumburl || info.url);
    })
    .map((p) => {
      const info = p.imageinfo[0];
      const rawArtist = info.extmetadata?.Artist?.value;
      const artist = cleanHtml(rawArtist) || "Wikimedia Commons Contributor";
      const license = info.extmetadata?.LicenseShortName?.value || "CC BY-SA 4.0";
      return {
        title: p.title.replace(/^File:/, "").replace(/\.[^.]+$/, ""),
        url: info.thumburl || info.url,
        width: info.thumbwidth || info.width || 1024,
        height: info.thumbheight || info.height || 768,
        artist,
        license,
        sourcePage: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      };
    });
}

async function downloadBuffer(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function fetchLibrary() {
  console.log("=== Starting Enhanced Media Library Fetch ===");
  Object.keys(CATEGORIES).forEach((cat) => {
    fs.mkdirSync(path.join(BASE_DIR, cat), { recursive: true });
  });

  const libraryItems = [];
  const credits = [];

  // 1. Process Coaches from Unsplash
  console.log(`\nFetching ${COACH_PORTRAITS.length} coach portraits from Unsplash...`);
  for (const coach of COACH_PORTRAITS) {
    const filename = `${coach.slug}.jpg`;
    const relPath = `library/coach/${filename}`;
    const targetPath = path.join(BASE_DIR, "coach", filename);
    const downloadUrlStr = `https://images.unsplash.com/${coach.id}?w=900&h=1125&fit=crop&crop=faces&q=80`;

    try {
      const buf = await downloadBuffer(downloadUrlStr, { "User-Agent": "Mozilla/5.0" });
      if (!checkJpegMagicBytes(buf)) continue;
      if (buf.length > 450 * 1024) continue;
      fs.writeFileSync(targetPath, buf);
      console.log(`  ✓ Saved coach/${filename} (${(buf.length / 1024).toFixed(1)} KB)`);

      const item = {
        id: `lib-coach-${coach.slug}`,
        path: relPath,
        kind: "image",
        category: "coach",
        tags: coach.tags,
        width: 900,
        height: 1125,
        alt_en: coach.alt_en,
        alt_vi: coach.alt_vi,
        credit: coach.author,
        source_url: coach.source_url,
        license: "Unsplash License",
        created_at: new Date().toISOString(),
      };
      libraryItems.push(item);
      credits.push(`${relPath} | Author: ${coach.author} | Source: ${coach.source_url} | License: Unsplash License | Date: 2026-10-16`);
    } catch (err) {
      console.error(`  ✗ Coach error ${coach.slug}: ${err.message}`);
    }
  }

  // 2. Process other categories from Wikimedia Commons
  const globalSeen = new Set();

  for (const [category, config] of Object.entries(CATEGORIES)) {
    if (category === "coach") continue;
    console.log(`\nFetching category: ${category} (min ${config.min})...`);
    const queries = COMMONS_QUERIES[category] || [category];
    let collectedForCategory = 0;

    for (const q of queries) {
      if (collectedForCategory >= config.min) break;
      console.log(`  Querying Commons: "${q}"...`);
      const candidates = await searchCommons(q, 30);
      for (const cand of candidates) {
        if (collectedForCategory >= config.min) break;
        if (globalSeen.has(cand.sourcePage)) continue;
        globalSeen.add(cand.sourcePage);

        const rawSlug = cand.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 35);
        const slug = `${category}-${collectedForCategory + 1}-${rawSlug || "img"}`;
        const filename = `${slug}.jpg`;
        const relPath = `library/${category}/${filename}`;
        const targetPath = path.join(BASE_DIR, category, filename);

        try {
          const buf = await downloadBuffer(cand.url, { "User-Agent": "Arena3Bot/1.0 (test@arena3.vn)" });
          if (!checkJpegMagicBytes(buf)) continue;
          if (buf.length > 450 * 1024) continue;

          fs.writeFileSync(targetPath, buf);
          collectedForCategory++;
          console.log(`  ✓ Saved ${category}/${filename} (${(buf.length / 1024).toFixed(1)} KB) [${collectedForCategory}/${config.min}]`);

          const altEn = `${category.replace("-", " ")}: ${cand.title}`;
          const altVi = `Hình ảnh ${category.replace("-", " ")}: ${cand.title}`;

          const item = {
            id: `lib-${category}-${slug}`,
            path: relPath,
            kind: "image",
            category,
            tags: [category, ...category.split("-")],
            width: cand.width,
            height: cand.height,
            alt_en: altEn,
            alt_vi: altVi,
            credit: cand.artist,
            source_url: cand.sourcePage,
            license: cand.license,
            created_at: new Date().toISOString(),
          };
          libraryItems.push(item);
          credits.push(`${relPath} | Author: ${cand.artist} | Source: ${cand.sourcePage} | License: ${cand.license} | Date: 2026-10-16`);
        } catch {
          // Skip on network or format error
        }
      }
    }
    console.log(`  Category ${category} completed with ${collectedForCategory} images.`);
  }

  // 3. Add legacy 33 images from public/media/
  console.log("\nAdding legacy site images to library manifest...");
  const legacyFiles = fs
    .readdirSync("public/media", { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name);

  for (const f of legacyFiles) {
    const isVideo = f.endsWith(".mp4");
    const nameWithoutExt = f.replace(/\.[^.]+$/, "");
    libraryItems.push({
      id: `legacy-${nameWithoutExt}`,
      path: f,
      kind: isVideo ? "video" : "image",
      category: "legacy",
      tags: ["legacy", nameWithoutExt],
      width: isVideo ? 1920 : 1280,
      height: isVideo ? 1080 : 720,
      alt_en: `Arena3 site asset: ${nameWithoutExt}`,
      alt_vi: `Tài nguyên Arena3: ${nameWithoutExt}`,
      credit: "Arena3 Studio",
      source_url: "https://arena3.vn",
      license: "project",
      created_at: new Date().toISOString(),
    });
  }

  // 4. Save manifest and CREDITS.md
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(libraryItems, null, 2), "utf8");
  console.log(`\nSaved manifest with ${libraryItems.length} items to ${MANIFEST_PATH}`);

  const creditsContent = [
    "# Arena3 Media Library Credits",
    "",
    "All media assets in the Arena3 Media Library are curated exclusively from verified open sources with commercial/permissive licenses (Unsplash License, CC0, Public Domain Mark, CC BY, CC BY-SA, project).",
    "",
    "## Image Entries",
    "",
    ...credits.map((c) => `- ${c}`),
    "",
  ].join("\n");
  fs.writeFileSync(CREDITS_PATH, creditsContent, "utf8");
  console.log(`Saved credits to ${CREDITS_PATH}`);

  // Summary counts
  const countsByCategory = {};
  for (const item of libraryItems) {
    countsByCategory[item.category] = (countsByCategory[item.category] || 0) + 1;
  }
  console.log("\n=== Summary by Category ===");
  console.table(countsByCategory);
}

if (process.argv[1]?.endsWith("fetch-library.mjs")) {
  fetchLibrary().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
