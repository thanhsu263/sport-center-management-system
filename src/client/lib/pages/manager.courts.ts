import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSports } from "@/client/components/sports-ui";
import { ApiClientError, apiPatch, apiPost } from "@/client/arena3/client";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";


type ManagerCourt = {
  id: string;
  court_code: string;
  sport: string;
  status: string;
  display_name: string | null;
  sort_order: number | null;
  retired_at: string | null;
  upcoming_bookings: number;
  active_classes: number;
  has_custom_price: boolean;
};


type AffectedItem = {
  kind: string;
  start_at: string;
  end_at: string;
  description: string;
};


const STATUS_OPTS = [
  { value: "ready", label: tk("Open"), tone: "accent" as const },
  { value: "maintenance", label: tk("Maintenance"), tone: "hold" as const },
  { value: "closed", label: tk("Closed"), tone: "danger" as const },
];

export function useManagerCourts() {
  const read = useRead<{ items: ManagerCourt[] }>("/manager/courts");
  const [items, setItems] = useState<ManagerCourt[] | null>(null);
  const [sport, setSport] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const pageSize = 25;

  const { sports } = useSports();
  // Dialog states
  const [creating, setCreating] = useState(false);
  const [createSport, setCreateSport] = useState("");
  useEffect(() => {
    if (!createSport && sports.length > 0) {
      setCreateSport(sports[0].code);
    }
  }, [createSport, sports]);
  const [createCode, setCreateCode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createSortOrder, setCreateSortOrder] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [editing, setEditing] = useState<ManagerCourt | null>(null);
  const [editCode, setEditCode] = useState("");
  const [editName, setEditName] = useState("");
  const [editSortOrder, setEditSortOrder] = useState("");
  const [editSport, setEditSport] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);

  const [retiring, setRetiring] = useState<ManagerCourt | null>(null);
  const [retireSubmitting, setRetireSubmitting] = useState(false);
  const [blockedRetire, setBlockedRetire] = useState<{
    court: ManagerCourt;
    message: string;
    affected: AffectedItem[];
  } | null>(null);

  const [actionBusy, setActionBusy] = useState<string | null>(null);

  useEffect(() => {
    if (read.data) setItems(read.data.items);
  }, [read.data]);

  // Compute summary stats
  const total = items ? items.length : 0;
  const readyCount = items ? items.filter((c) => !c.retired_at && c.status === "ready").length : 0;
  const maintCount = items ? items.filter((c) => !c.retired_at && c.status === "maintenance").length : 0;
  const retiredCount = items ? items.filter((c) => c.retired_at).length : 0;

  // Next court code suggestion for create dialog
  useEffect(() => {
    if (!creating || !items) return;
    const sportObj = sports.find((s) => s.code === createSport);
    const prefix = sportObj?.court_prefix ? `${sportObj.court_prefix}-` : "CT-";
    const used = new Set<number>();
    for (const c of items) {
      if (c.court_code.startsWith(prefix)) {
        const m = /^[A-Z]{2}-(\d+)$/.exec(c.court_code);
        if (m && m[1]) used.add(parseInt(m[1], 10));
      }
    }
    let n = 1;
    while (used.has(n)) n++;
    setCreateCode(`${prefix}${String(n).padStart(2, "0")}`);
  }, [creating, createSport, items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    return items.filter((c) => {
      if (sport && c.sport !== sport) return false;
      if (statusFilter === "retired" && !c.retired_at) return false;
      if (statusFilter === "active" && c.retired_at) return false;
      if (statusFilter === "ready" && (c.retired_at || c.status !== "ready")) return false;
      if (statusFilter === "maintenance" && (c.retired_at || c.status !== "maintenance")) return false;
      if (statusFilter === "closed" && (c.retired_at || c.status !== "closed")) return false;
      return true;
    });
  }, [items, sport, statusFilter]);

  const pagedItems = filtered.slice(offset, offset + pageSize);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateSubmitting(true);
    try {
      const res = await apiPost<{ court: ManagerCourt }>("/manager/courts", {
        sport: createSport,
        court_code: createCode.trim() || undefined,
        display_name: createName.trim() || undefined,
        sort_order: createSortOrder ? Number(createSortOrder) : undefined,
      });
      toast.success(t("Court created"));
      setCreating(false);
      setCreateName("");
      setCreateSortOrder("");
      setItems((prev) => (prev ? [...prev, res.court] : [res.court]));
      void read.reload();
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
    } finally {
      setCreateSubmitting(false);
    }
  }

  function startEdit(c: ManagerCourt) {
    setEditing(c);
    setEditCode(c.court_code);
    setEditName(c.display_name ?? "");
    setEditSortOrder(c.sort_order != null ? String(c.sort_order) : "");
    setEditSport(c.sport);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setEditSubmitting(true);
    try {
      const res = await apiPatch<{ court: ManagerCourt; upcoming: number }>(`/courts/${editing.id}`, {
        court_code: editCode.trim(),
        display_name: editName.trim() || null,
        sort_order: editSortOrder ? Number(editSortOrder) : null,
        sport: editSport,
      });
      toast.success(t("Court updated"));
      setEditing(null);
      setItems((prev) => (prev ? prev.map((c) => (c.id === editing.id ? { ...c, ...res.court } : c)) : null));
      void read.reload();
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleStatusChange(court: ManagerCourt, newStatus: string) {
    if (court.status === newStatus || actionBusy) return;
    setActionBusy(court.id);
    try {
      const res = await apiPatch<{ court: ManagerCourt; upcoming: number }>(`/courts/${court.id}`, {
        status: newStatus,
      });
      toast.success(t("{code} → {label}", { code: court.court_code, label: t(newStatus) }));
      setItems((prev) => (prev ? prev.map((c) => (c.id === court.id ? { ...c, status: res.court.status } : c)) : null));
      void read.reload();
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Cannot change court status"));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRetire(court: ManagerCourt) {
    setRetireSubmitting(true);
    try {
      const res = await apiPost<{ ok: boolean; court: ManagerCourt }>(`/manager/courts/${court.id}/retire`, {});
      toast.success(t("Court retired"));
      setRetiring(null);
      setItems((prev) => (prev ? prev.map((c) => (c.id === court.id ? { ...c, ...res.court } : c)) : null));
      void read.reload();
    } catch (err) {
      setRetiring(null);
      if (err instanceof ApiClientError && err.status === 409) {
        const body = err.body as { message?: string; affected?: AffectedItem[]; extra?: { affected?: AffectedItem[] } };
        setBlockedRetire({
          court,
          message: err.message,
          affected: body.affected ?? body.extra?.affected ?? [],
        });
      } else {
        toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
      }
    } finally {
      setRetireSubmitting(false);
    }
  }

  async function handleRestore(court: ManagerCourt) {
    setActionBusy(court.id);
    try {
      const res = await apiPost<{ ok: boolean; court: ManagerCourt }>(`/manager/courts/${court.id}/restore`, {});
      toast.success(t("Court restored"));
      setItems((prev) => (prev ? prev.map((c) => (c.id === court.id ? { ...c, ...res.court } : c)) : null));
      void read.reload();
    } catch (err) {
      toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
    } finally {
      setActionBusy(null);
    }
  }

  const statItems = [
    { label: t("Courts in service"), value: readyCount },
    { label: t("Maintenance"), value: maintCount },
    { label: t("Retired"), value: retiredCount },
    { label: t("Total courts"), value: total },
  ];
  return {
    read, items, sport, setSport, statusFilter, setStatusFilter, offset, setOffset, pageSize,
    sports, creating, setCreating, createSport, setCreateSport, createCode, setCreateCode,
    createName, setCreateName, createSortOrder, setCreateSortOrder, createSubmitting, editing,
    setEditing, editCode, setEditCode, editName, setEditName, editSortOrder, setEditSortOrder,
    editSport, setEditSport, editSubmitting, retiring, setRetiring, retireSubmitting,
    blockedRetire, setBlockedRetire, actionBusy, total, filtered, pagedItems, handleCreate,
    startEdit, handleEdit, handleStatusChange, handleRetire, handleRestore, statItems,
  };
}

export { STATUS_OPTS };
