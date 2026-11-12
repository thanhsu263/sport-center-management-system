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

export const pct1 = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

type PeakRule = { sport: string; start_min: number; end_min: number };

function peakHoursFor(rules: PeakRule[]) {
  const bySport = new Map<string, Map<number, boolean>>();
  return (sport: string, hour: number) => {
    let hours = bySport.get(sport);
    if (!hours) {
      hours = new Map();
      bySport.set(sport, hours);
    }
    if (!hours.has(hour)) {
      const minute = hour * 60;
      hours.set(hour, rules.some((rule) => rule.sport === sport && rule.start_min <= minute && rule.end_min > minute));
    }
    return hours.get(hour)!;
  };
}

function groupCapacity(cells: CapacityCell[], rules: PeakRule[]) {
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
  for (const c of cells) {
    const open = c.slots * 60;
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
    const hh = byHour.get(c.hr) ?? { sold: 0, open: 0 };
    hh.sold += c.sold_min;
    hh.open += open;
    byHour.set(c.hr, hh);
  }
  return { byCourt, bySport, byHour };
}

export function summarizeCapacity(cells: CapacityCell[], rules: PeakRule[], openHour: number, closeHour: number, daysTotal: number) {
  const hours = Array.from({ length: Math.max(0, closeHour - openHour) }, (_, i) => openHour + i);
  const { byCourt, bySport, byHour } = groupCapacity(cells, rules);
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
  const all = courts.reduce((a, c) => ({ sold: a.sold + c.sold_min, open: a.open + c.open_min }), { sold: 0, open: 0 });
  return { hours, courts, all, bySport, byHour };
}
