/**
 * File: scripts/tests/agent/ts-loader.mjs
 * Vai trò: Đăng ký module customization hooks (resolve và load) cho Node.js ESM.
 * Giúp Node.js chạy trực tiếp mã nguồn TypeScript (.ts, .tsx), tự động giải quyết
 * path alias "@/...", tìm file khi thiếu extension và mock file font .ttf trong môi trường test/benchmark.
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

registerHooks({
  /**
   * Làm gì: Hook phân giải đường dẫn module (resolve). Chuyển đổi alias "@/" thành đường dẫn thực tế trong thư mục "src/" và tự động bù đuôi file (.ts, .tsx, /index.ts) khi Node ESM không tìm thấy file.
   * Được gọi ở: Node.js module loader pipeline (khi thực thi script import ts-loader.mjs, ví dụ: scripts/perf-probe.mjs).
   * @param specifier Chuỗi định danh module hoặc đường dẫn được import.
   * @param context Ngữ cảnh chứa thông tin module gọi (parentURL, conditions).
   * @param nextResolve Hàm resolve mặc định kế tiếp trong chuỗi hook của Node.js.
   * @returns Đối tượng chứa url đã phân giải và format của module.
   * @throws Error nếu đường dẫn không tồn tại và không khớp file TS/TSX nào trên đĩa.
   */
  resolve(specifier, context, nextResolve) {
    // Bước 1: Chuẩn hóa alias "@/" thành file URL tuyệt đối trỏ vào thư mục "src/".
    const target = specifier.startsWith("@/") ? pathToFileURL(resolve("src", specifier.slice(2))).href : specifier;
    // Bước 2: Thử resolve theo cơ chế mặc định của Node.js trước.
    try {
      return nextResolve(target, context);
    } catch (error) {
      // Bước 3: Nếu thất bại với file URL hoặc relative path, dò tìm file thực tế với đuôi .ts, .tsx hoặc /index.ts.
      if (target.startsWith(".") || target.startsWith("file:")) {
        const url = new URL(target, context.parentURL);
        for (const suffix of [".ts", ".tsx", "/index.ts"]) {
          if (existsSync(fileURLToPath(url) + suffix)) return nextResolve(url.href + suffix, context);
        }
      }
      // Ném lại lỗi ban đầu nếu không tìm thấy file nào khớp trên ổ đĩa.
      throw error;
    }
  },
  /**
   * Làm gì: Hook tải và chuyển mã (transpile) module. Mock file font .ttf thành chuỗi rỗng và biên dịch mã nguồn TypeScript/TSX sang JavaScript ES2022 để Node.js thực thi trực tiếp.
   * Được gọi ở: Node.js module loader pipeline (sau khi resolve thành công URL của module).
   * @param url URL tuyệt đối dạng file:// của module cần nạp.
   * @param context Ngữ cảnh nạp module (format được resolve, conditions...).
   * @param nextLoad Hàm load mặc định kế tiếp trong chuỗi hook của Node.js.
   * @returns Đối tượng chứa format (module), source code sau khi transpile và cờ shortCircuit: true, hoặc kết quả từ nextLoad.
   * @throws Error nếu đọc file thất bại hoặc ts.transpileModule gặp lỗi cú pháp.
   */
  load(url, context, nextLoad) {
    // Bước 1: Mock file font .ttf thành module rỗng để tránh lỗi nạp dữ liệu nhị phân khi chạy trên Node.
    if (url.includes(".ttf")) return { format: "module", source: 'export default "";', shortCircuit: true };
    // Bước 2: Với file TypeScript (.ts, .tsx) thuộc project (bỏ qua node_modules), biên dịch on-the-fly sang ES2022 bằng ts.transpileModule.
    if (/\.tsx?$/.test(url) && !url.includes("/node_modules/")) return {
      format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: fileURLToPath(url) }).outputText,
      shortCircuit: true,
    };
    // Bước 3: Chuyển các định dạng module khác (JS thuần, JSON...) cho loader mặc định của Node.js xử lý.
    return nextLoad(url, context);
  },
});
