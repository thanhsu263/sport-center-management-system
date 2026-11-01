import fs from "node:fs";

const BAD_WORDS = [
  "centre-bell", "canadiens", "bell centre", "marines", "navy",
  "ivanov", "limpele", "sozonov", "fiba", "penn-state", "penn state",
  "nationals", "podium", "kowalczyk", "bj-rgen", "kim yuna", "yuna",
  "boycott", "apartheid", "farzam", "humphries", "tinling",
  "spikes-a-point", "colosseum", "olympic", "paralympic", "medal"
];

export async function searchCommons(query, limit = 20) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent('filetype:bitmap ' + query)}&gsrnamespace=6&prop=imageinfo&iiprop=url|size|extmetadata&format=json&gsrlimit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": "Arena3Curator/1.0 (info@arena3.vn)" } });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {});
  const results = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info || !info.url) continue;
    const title = (p.title || "").replace(/^File:/, "");
    const lower = (title + " " + (info.extmetadata?.ObjectName?.value || "")).toLowerCase();
    if (BAD_WORDS.some((b) => lower.includes(b))) continue;

    const license = info.extmetadata?.LicenseShortName?.value || "CC BY-SA 4.0";
    // Check if acceptable license
    const licLower = license.toLowerCase();
    if (licLower.includes("nc") || licLower.includes("nd")) continue;

    const artist = (info.extmetadata?.Artist?.value || "Wikimedia Commons")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Use Wikimedia 1920 thumb URL if image is large
    let downloadUrl = info.url;
    if (info.width > 1920) {
      // Wikimedia thumb format
      const parts = info.url.split("/");
      const fn = parts[parts.length - 1];
      const prefix = info.url.replace("commons/", "commons/thumb/");
      downloadUrl = `${prefix}/1920px-${fn}`;
    }

    results.push({
      title,
      downloadUrl,
      sourceUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}`,
      width: Math.min(info.width, 1920),
      height: Math.round(info.height * (Math.min(info.width, 1920) / info.width)),
      artist,
      license,
    });
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith("query-wikimedia.mjs")) {
  searchCommons("indoor badminton court", 10).then(r => {
    console.log("Found:", r.length);
    for (const item of r.slice(0, 5)) {
      console.log(item.title, item.license, item.artist);
    }
  });
}
