import { useEffect, useState } from "react";
import { toast } from "sonner";
import { invalidateSportsCache } from "@/client/components/sports-ui";
import { useRefreshAssets } from "@/client/components/media";
import { apiDelete, apiPatch, apiPost } from "@/client/arena3/client";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

type ManagerSport = {
  code: string;
  name_en: string;
  name_vi: string;
  court_prefix: string | null;
  color_key: string;
  glyph_key: string;
  is_scope_all: boolean;
  max_players: number;
  slot_duration_min: number;
  sort_order: number;
  enabled: boolean;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
  active_courts_count: number;
  future_bookings_count: number;
  future_classes_count: number;
  photo_url: string;
};


const COLOR_KEYS = [
  { key: "leaf", label: tk("Leaf (Green)") },
  { key: "clay", label: tk("Clay (Terracotta)") },
  { key: "sun", label: tk("Sun (Amber)") },
  { key: "sky", label: tk("Sky (Blue)") },
  { key: "plum", label: tk("Plum (Purple)") },
  { key: "slate", label: tk("Slate (Grey)") },
  { key: "moss", label: tk("Moss (Olive)") },
  { key: "dune", label: tk("Dune (Sand)") },
] as const;


const GLYPH_KEYS = [
  { key: "generic", label: tk("Generic Sport") },
  { key: "badminton", label: tk("Shuttlecock") },
  { key: "basketball", label: tk("Basketball") },
  { key: "volleyball", label: tk("Volleyball") },
] as const;


const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];


function imageSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      reject(new Error("unreadable"));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}


/** Why the server would turn this picture down, in the manager's language; null when it fits. */
async function photoProblem(file: File): Promise<string | null> {
  if (!PHOTO_TYPES.includes(file.type)) return t("Choose a JPEG, PNG or WebP picture.");
  if (file.size > 2 * 1024 * 1024) return t("The photo must be 2 MB or smaller.");
  try {
    const { w, h } = await imageSize(file);
    if (Math.min(w, h) < 400 || Math.max(w, h) > 4000) {
      return t("The shorter side needs 400 px or more, the longer side 4000 px or less.");
    }
  } catch {
    return t("This file could not be read as a picture.");
  }
  return null;
}


function uploadSportPhoto(code: string, file: File) {
  const fd = new FormData();
  fd.append("slot", `sport.${code}`);
  fd.append("file", file);
  return apiPost("/manager/site-assets/upload", fd);
}

export function useManagerSports() {
  const read = useRead<{ items: ManagerSport[] }>("/manager/sports");
  const refreshAssets = useRefreshAssets();
  const [items, setItems] = useState<ManagerSport[] | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "retired">("");

  // Create state
  const [creating, setCreating] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [cCode, setCCode] = useState("");
  const [cNameEn, setCNameEn] = useState("");
  const [cNameVi, setCNameVi] = useState("");
  const [cPrefix, setCPrefix] = useState("");
  const [cColor, setCColor] = useState("leaf");
  const [cGlyph, setCGlyph] = useState("generic");
  const [cMaxPlayers, setCMaxPlayers] = useState("4");
  const [cWeekdayPrice, setCWeekdayPrice] = useState("100000");
  const [cWeekdayPeak, setCWeekdayPeak] = useState("150000");
  const [cWeekendPrice, setCWeekendPrice] = useState("120000");
  const [cWeekendPeak, setCWeekendPeak] = useState("180000");
  const [cPhoto, setCPhoto] = useState<File | null>(null);
  const [cSubmitting, setCSubmitting] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<ManagerSport | null>(null);
  const [eNameEn, setENameEn] = useState("");
  const [eNameVi, setENameVi] = useState("");
  const [ePrefix, setEPrefix] = useState("");
  const [eColor, setEColor] = useState("leaf");
  const [eGlyph, setEGlyph] = useState("generic");
  const [eSortOrder, setESortOrder] = useState("100");
  const [eEnabled, setEEnabled] = useState(true);
  const [eSubmitting, setESubmitting] = useState(false);

  // Retire / Delete confirmation states
  const [retiring, setRetiring] = useState<ManagerSport | null>(null);
  const [retireBlockers, setRetireBlockers] = useState<string[] | null>(null);
  const [retireSubmitting, setRetireSubmitting] = useState(false);

  const [deleting, setDeleting] = useState<ManagerSport | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  useEffect(() => {
    if (read.data?.items) {
      setItems(read.data.items);
    }
  }, [read.data]);

  const allList = items ?? [];
  const playableList = allList.filter((s) => !s.is_scope_all);

  const filtered = playableList.filter((s) => {
    if (statusFilter === "active" && (!s.enabled || s.retired_at)) return false;
    if (statusFilter === "retired" && !s.retired_at) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      s.code.toLowerCase().includes(q) ||
      s.name_en.toLowerCase().includes(q) ||
      s.name_vi.toLowerCase().includes(q) ||
      (s.court_prefix && s.court_prefix.toLowerCase().includes(q))
    );
  });

  const totalCourts = playableList.reduce((acc, s) => acc + (s.active_courts_count || 0), 0);
  const activeSports = playableList.filter((s) => s.enabled && !s.retired_at).length;

  function openCreate() {
    setCCode("");
    setCNameEn("");
    setCNameVi("");
    setCPrefix("");
    setCColor("leaf");
    setCGlyph("generic");
    setCMaxPlayers("4");
    setCWeekdayPrice("100000");
    setCWeekdayPeak("150000");
    setCWeekendPrice("120000");
    setCWeekendPeak("180000");
    setCPhoto(null);
    setCreateStep(1);
    setCreating(true);
  }

  function openEdit(sport: ManagerSport) {
    setEditing(sport);
    setENameEn(sport.name_en);
    setENameVi(sport.name_vi);
    setEPrefix(sport.court_prefix ?? "");
    setEColor(sport.color_key);
    setEGlyph(sport.glyph_key);
    setESortOrder(String(sport.sort_order));
    setEEnabled(sport.enabled);
  }

  async function handleCreate() {
    setCSubmitting(true);
    try {
      const res = await apiPost<{ ok: boolean; sport: ManagerSport }>("/manager/sports", {
        code: cCode.trim().toLowerCase(),
        name_en: cNameEn.trim(),
        name_vi: cNameVi.trim(),
        court_prefix: cPrefix.trim().toUpperCase(),
        color_key: cColor,
        glyph_key: cGlyph,
        max_players: Number(cMaxPlayers) || 4,
        weekday_price_vnd: Number(cWeekdayPrice) || 100000,
        weekday_peak_price_vnd: Number(cWeekdayPeak) || 150000,
        weekend_price_vnd: Number(cWeekendPrice) || 120000,
        weekend_peak_price_vnd: Number(cWeekendPeak) || 180000,
      });
      toast.success(t("Sport {name} created", { name: res.sport.name_en }));
      if (cPhoto) {
        try {
          await uploadSportPhoto(res.sport.code, cPhoto);
          await refreshAssets();
        } catch (e) {
          toast.error(t("The sport was saved without its photo: {reason}", { reason: tServer((e as Error).message) }));
        }
      }
      invalidateSportsCache();
      setCreating(false);
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setCSubmitting(false);
    }
  }

  async function handleEdit() {
    if (!editing) return;
    setESubmitting(true);
    try {
      await apiPatch<{ ok: boolean; sport: ManagerSport }>(`/manager/sports/${editing.code}`, {
        name_en: eNameEn.trim(),
        name_vi: eNameVi.trim(),
        court_prefix: ePrefix.trim().toUpperCase() || undefined,
        color_key: eColor,
        glyph_key: eGlyph,
        sort_order: Number(eSortOrder) || 100,
        enabled: eEnabled,
      });
      toast.success(t("Sport updated"));
      invalidateSportsCache();
      setEditing(null);
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setESubmitting(false);
    }
  }

  async function handleRetire(sport: ManagerSport) {
    setRetireSubmitting(true);
    setRetireBlockers(null);
    try {
      await apiPost(`/manager/sports/${sport.code}/retire`, {});
      toast.success(t("Sport retired"));
      invalidateSportsCache();
      setRetiring(null);
      read.reload();
    } catch (e: any) {
      if (e.status === 409 && e.body?.reasons) {
        setRetireBlockers(e.body.reasons);
      } else {
        toast.error(tServer(e.message));
        setRetiring(null);
      }
    } finally {
      setRetireSubmitting(false);
    }
  }

  async function handleRestore(sport: ManagerSport) {
    try {
      await apiPost(`/manager/sports/${sport.code}/restore`, {});
      toast.success(t("Sport restored"));
      invalidateSportsCache();
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    }
  }

  async function handleDelete(sport: ManagerSport) {
    setDeleteSubmitting(true);
    try {
      await apiDelete(`/manager/sports/${sport.code}`);
      toast.success(t("Sport deleted"));
      invalidateSportsCache();
      setDeleting(null);
      read.reload();
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setDeleteSubmitting(false);
    }
  }
  return {
    read, items, query, setQuery, statusFilter, setStatusFilter, creating, setCreating, createStep,
    setCreateStep, cCode, setCCode, cNameEn, setCNameEn, cNameVi, setCNameVi, cPrefix, setCPrefix,
    cColor, setCColor, cGlyph, setCGlyph, cMaxPlayers, setCMaxPlayers, cWeekdayPrice,
    setCWeekdayPrice, cWeekdayPeak, setCWeekdayPeak, cWeekendPrice, setCWeekendPrice, cWeekendPeak,
    setCWeekendPeak, cPhoto, setCPhoto, cSubmitting, editing, setEditing, eNameEn, setENameEn,
    eNameVi, setENameVi, ePrefix, setEPrefix, eColor, setEColor, eGlyph, setEGlyph, eSortOrder,
    setESortOrder, eEnabled, setEEnabled, eSubmitting, retiring, setRetiring, retireBlockers,
    retireSubmitting, deleting, setDeleting, deleteSubmitting, playableList, filtered, totalCourts,
    activeSports, openCreate, openEdit, handleCreate, handleEdit, handleRetire, handleRestore,
    handleDelete,
  };
}

export { type ManagerSport, COLOR_KEYS, GLYPH_KEYS, PHOTO_TYPES, photoProblem, uploadSportPhoto };
