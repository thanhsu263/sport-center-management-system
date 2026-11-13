import { useState } from "react";
import { toast } from "sonner";
import { apiPatch } from "@/client/arena3/client";
import { type MediaAspectRatio, type MediaSlotGroup } from "@/shared/arena3/media";
import { locale, t } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

type ManagerAsset = {
  slot: string;
  kind: "image" | "video";
  url: string;
  default_path: string;
  alt_en: string;
  alt_vi: string;
  enabled: boolean;
  width: number | null;
  height: number | null;
  version: number;
  updated_at: string;
  updated_by: string | null;
  history_count: number;
  label_en: string;
  label_vi: string;
  location_en: string;
  location_vi: string;
  group: MediaSlotGroup;
  aspect: MediaAspectRatio;
};

type MediaLibraryItem = {
  id: string;
  path: string;
  kind: string;
  category: string;
  tags: string[];
  width: number | null;
  height: number | null;
  alt_en: string;
  alt_vi: string;
  credit: string | null;
  source_url: string | null;
  license: string;
  created_at: string;
  url: string;
  name: string;
};


function recDim(aspect: MediaAspectRatio): string {
  switch (aspect) {
    case "16:9":
      return "1920 × 1080";
    case "4:5":
      return "1200 × 1500";
    case "3:4":
      return "1200 × 1600";
    case "1:1":
      return "800 × 800";
    default:
      return "1920 × 1080";
  }
}


function aspectClass(aspect: MediaAspectRatio): string {
  switch (aspect) {
    case "16:9":
      return "aspect-video";
    case "4:5":
      return "aspect-[4/5]";
    case "3:4":
      return "aspect-[3/4]";
    case "1:1":
      return "aspect-square";
    default:
      return "aspect-video";
  }
}


async function compressImageToWebp(file: File): Promise<{ blob: Blob; width: number; height: number; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const maxDim = 2400;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas context failed"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Canvas compression failed"));
              return;
            }
            const previewUrl = URL.createObjectURL(blob);
            resolve({ blob, width, height, previewUrl });
          },
          "image/webp",
          0.85,
        );
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function useManagerMedia() {
  const [activeTab, setActiveTab] = useState<"slots" | "library">("slots");
  const { data, error, reload } = useRead<{ items: ManagerAsset[] }>("/manager/site-assets");
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [uploadSlot, setUploadSlot] = useState<ManagerAsset | null>(null);
  const [librarySlot, setLibrarySlot] = useState<ManagerAsset | null>(null);
  const [altSlot, setAltSlot] = useState<ManagerAsset | null>(null);
  const [confirmRevertSlot, setConfirmRevertSlot] = useState<ManagerAsset | null>(null);
  const [confirmResetSlot, setConfirmResetSlot] = useState<ManagerAsset | null>(null);

  const isVi = locale() === "vi";
  const items = data?.items ?? [];

  const groups: Array<{ value: string; label: string }> = [
    { value: "all", label: t("All groups") },
    { value: "landing", label: t("Homepage") },
    { value: "auth", label: t("Auth & onboarding") },
    { value: "banner", label: t("Inner banners") },
    { value: "sport", label: t("Sport covers") },
    { value: "coach", label: t("Coaches") },
    { value: "brand", label: t("Brand & default") },
  ];

  const filteredItems = items.filter((it) => {
    if (selectedGroup === "all") return true;
    return it.group === selectedGroup;
  });

  async function toggleEnabled(item: ManagerAsset) {
    try {
      await apiPatch(`/manager/site-assets/${encodeURIComponent(item.slot)}`, {
        enabled: !item.enabled,
      });
      toast.success(t("Status updated"));
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Something went wrong"));
    }
  }

  const totalSlots = items.length;
  const enabledSlots = items.filter((i) => i.enabled).length;
  const customSlots = items.filter((i) => i.history_count > 0 || i.version > 1).length;
  const disabledSlots = totalSlots - enabledSlots;
  return {
    activeTab, setActiveTab, data, error, reload, selectedGroup, setSelectedGroup, uploadSlot,
    setUploadSlot, librarySlot, setLibrarySlot, altSlot, setAltSlot, confirmRevertSlot,
    setConfirmRevertSlot, confirmResetSlot, setConfirmResetSlot, isVi, groups, filteredItems,
    toggleEnabled, totalSlots, enabledSlots, customSlots, disabledSlots,
  };
}

export { type ManagerAsset, type MediaLibraryItem, recDim, aspectClass, compressImageToWebp };
