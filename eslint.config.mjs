/**
 * Tệp cấu hình ESLint (Flat Config) cho toàn bộ dự án.
 * Thiết lập các quy chuẩn kiểm tra mã nguồn (linting), phát hiện sớm lỗi cú pháp và logic
 * cho JavaScript, TypeScript và React (React Hooks, React Refresh) trong ứng dụng TanStack Start.
 * Tệp này tích hợp với Prettier để tránh xung đột định dạng, được gọi khi chạy npm run lint hoặc qua ESLint extension trong IDE.
 */
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Flat ESLint config for the TanStack Start app-builder template. */
export default tseslint.config(
  // Cấu hình bỏ qua toàn cục (Global Ignores): loại trừ thư mục build, thư viện, code tự sinh và công cụ khỏi phạm vi kiểm tra lint.
  {
    ignores: [
      "dist/**",
      ".output/**",
      ".vercel/**",
      ".nitro/**",
      "node_modules/**",
      "agent/**",
      "src/routeTree.gen.ts",
      // Tooling, agent skills, scripts, and test suites are not app code.
      ".claude/**",
      ".agents/**",
      ".cursor/**",
      ".gemini/**",
      "docs/**",
      "scripts/**",
      "test-output/**",
    ],
  },
  // Áp dụng bộ quy tắc khuyến nghị chuẩn của ESLint cho mã JavaScript cốt lõi.
  js.configs.recommended,
  // Kế thừa các quy tắc khuyến nghị của typescript-eslint để kiểm tra an toàn kiểu dữ liệu.
  ...tseslint.configs.recommended,
  // Cấu hình kiểm tra chi tiết áp dụng cho tất cả các tệp mã nguồn trong dự án.
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // Áp dụng các quy tắc chuẩn cho React Hooks (đảm bảo gọi hook đúng thứ tự và khai báo đủ dependencies).
      ...reactHooks.configs.recommended.rules,
      // Cảnh báo nếu file component export biến khác ngoài React component, đảm bảo Fast Refresh (HMR) không bị reload toàn trang.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Cảnh báo biến không sử dụng nhưng cho phép bỏ qua nếu tên bắt đầu bằng dấu gạch dưới (ví dụ: _req, _index).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Tắt cấm dùng kiểu any để linh hoạt khi tương tác với dữ liệu động hoặc thư viện ngoài.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Disable rules that conflict with Prettier formatting.
  prettier,
);
