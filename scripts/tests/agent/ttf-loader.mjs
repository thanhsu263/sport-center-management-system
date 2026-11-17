/**
 * File này cung cấp custom ESM loader cho Node.js khi chạy test runner.
 * Giúp giả lập (mock) các file font TrueType (.ttf) thành ES module rỗng, tránh lỗi ERR_UNKNOWN_FILE_EXTENSION khi import các service có dùng font (như pdf.ts).
 */
/**
 * Làm gì: Chặn quá trình nạp module của Node.js; nếu là file font .ttf thì ngắt chuỗi và trả về module rỗng giả lập, ngược lại ủy quyền cho loader tiếp theo.
 * Được gọi ở: test runner (node --test), qua register() trong src/server/controllers/tx.test.ts.
 * @param url Đường dẫn URL của module đang được nạp.
 * @param context Ngữ cảnh nạp module do Node.js cung cấp (định dạng, import attributes...).
 * @param nextLoad Hàm callback nạp tiếp theo trong chuỗi loader của Node.js.
 * @returns Đối tượng module giả lập cho file .ttf (format 'module', source rỗng) hoặc kết quả từ nextLoad.
 */
export async function load(url, context, nextLoad) {
  // Bước 1: Kiểm tra nếu URL import là file font chữ .ttf.
  if (url.includes('.ttf')) {
    // Trả về module rỗng và ngắt chuỗi (shortCircuit: true) để Node.js không phân tích file nhị phân font, tránh lỗi ERR_UNKNOWN_FILE_EXTENSION.
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default "";',
    };
  }
  // Bước 2: Với các file không phải .ttf, bàn giao lại cho loader mặc định của Node.js xử lý tiếp.
  return nextLoad(url, context);
}
