/**
 * Tiện ích quản lý và kết hợp class name cho toàn bộ giao diện client.
 * Tích hợp clsx để nối class theo điều kiện và tailwind-merge để giải quyết xung đột class của Tailwind CSS.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Làm gì: Nối các class name, lọc bỏ các giá trị falsy và tự động giải quyết xung đột class Tailwind CSS (ưu tiên class khai báo sau).
 * Được gọi ở: Hầu hết các UI component trong src/client/components/ (arena-icons.tsx, assistant-widget.tsx, availability-calendar.tsx,...).
 * @param inputs Danh sách các class name, mảng class hoặc object điều kiện cần gộp.
 * @returns Chuỗi class name hoàn chỉnh đã được xử lý xung đột.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
