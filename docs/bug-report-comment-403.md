Tiêu đề: [BUG] Reader xóa comment của chính họ trả 403 — cần xác minh nguyên nhân gốc trước khi sửa

Mô tả ngắn
User A đăng nhập → comment vào 1 series public → nhấn Xóa comment → BE trả về 403 "Not authorized to delete this comment" mặc dù user đó chính là chủ comment.

Endpoint: DELETE /comments/:commentId
File: routes/comments.js (dòng 311–313 cho PATCH, dòng 364–366 cho DELETE)

Lưu ý kỹ thuật (đã verify bằng REPL)
Trước khi refactor, mình muốn loại trừ chính xác nguyên nhân. Test nhanh với jsonwebtoken + mongoose:

const oid = new mongoose.Types.ObjectId();
const token = jwt.sign({ nameid: oid }, 'secret');
const decoded = jwt.verify(token, 'secret');
// decoded.nameid là 'string' (hex 24-char), KHÔNG phải ObjectId instance
String(decoded.nameid) === String(oid)                     // → true
new mongoose.Types.ObjectId(decoded.nameid).equals(oid)    // → true

Kết luận: pattern `String(comment.reader_id) !== String(req.user.nameid)` hiện tại về lý thuyết vẫn match đúng. Nếu 403 trả về, nguyên nhân nằm ở chỗ KHÁC, không phải chỗ so sánh này.

Các nguyên nhân khả dĩ cần kiểm tra (theo thứ tự ưu tiên)

1. `req.user.nameid` bị undefined khi vào handler
   - Token được sign nhưng KHÔNG có field `nameid` (vd: token cũ trước khi refactor auth, hoặc token từ flow khác như Google login nếu có).
   - Khi đó `String(req.user.nameid)` ra `"undefined"`, so với `String(comment.reader_id)` (24-char hex) → không match → 403.
   - Verify: log `console.log(req.user)` ở đầu handler DELETE /comments/:commentId.

2. User login bằng flow không phải /auth/login
   - Ví dụ OTP login, social login, refresh token flow — payload có thể dùng key khác (`sub`, `id`, `userId`) thay vì `nameid`.
   - Check `routes/auth.js` (cả send-otp, verify-otp, login) để đảm bảo MỌI flow sign token đều đặt `nameid: user._id`.

3. JWT_SECRET bị rotate hoặc env khác nhau giữa các instance
   - Sign bằng key A, verify bằng key B → token hợp lệ ở 1 nơi, fail ở nơi khác. Verify bằng cách decode token tại client (jwt.io) và so với `process.env.JWT_SECRET` ở server (chỉ để check, không share secret).

4. `comment.reader_id` lưu sai định dạng
   - Có 1 vài comment cũ (trước khi schema cast) mà `reader_id` được lưu thành string thuần thay vì ObjectId.
   - Verify: `db.comments.findOne({ _id: ObjectId('...') })` xem field `reader_id` là `ObjectId("...")` hay `"..."` (string).

5. Comment tạo bởi user bị xóa / user khác truyện
   - Check user còn tồn tại trong DB không.

Đề xuất cách xử lý (theo từng bước)

Bước 1 — Reproduce + log
Thêm tạm log ở đầu handler DELETE /comments/:commentId:
```js
console.log("[DELETE /comments]", {
  commentId: req.params.commentId,
  userId: req.user?.nameid,
  userRole: req.user?.role,
  fullUser: req.user,
});
const comment = await Comment.findById(req.params.commentId);
console.log("[DELETE /comments]", {
  commentExists: !!comment,
  reader_id: comment?.reader_id,
  reader_id_type: typeof comment?.reader_id,
  reader_id_string: comment?.reader_id?.toString(),
  match: comment?.reader_id?.toString() === req.user?.nameid?.toString(),
});
```
Bước 2 — Phụ thuộc vào kết quả log
- Nếu `req.user.nameid` là undefined → sửa auth flow (nguyên nhân #1 hoặc #2).
- Nếu `comment.reader_id` là string thay vì ObjectId → migrate data (nguyên nhân #4).
- Nếu cả 2 đều match ở console mà vẫn trả 403 → check middleware: có middleware nào transform req.user trước handler không.

Bước 3 — Sau khi fix root cause
Cân nhắc (không bắt buộc) thêm defensive check ở handler:
```js
// Helper an toàn hơn, không phụ thuộc type
const isOwner = (a, b) => {
  if (!a || !b) return false;
  try {
    return new mongoose.Types.ObjectId(String(a)).equals(new mongoose.Types.ObjectId(String(b)));
  } catch {
    return false;
  }
};
```
Dùng `isOwner(comment.reader_id, req.user.nameid)` — vừa không phụ thuộc format, vừa tránh crash khi 1 trong 2 bên null/invalid.

Việc cần làm thêm
- [ ] Kiểm tra PATCH /comments/:commentId (cùng pattern dòng 311–313) — có fail tương tự không.
- [ ] Kiểm tra routes/votes.js dòng 97 (cùng pattern) — có fail tương tự không.
- [ ] Cân nhắc cho phép Admin xóa comment của người khác (hiện `requireReader` đang chặn mọi role không phải Reader).
- [ ] Check tất cả auth flows trong routes/auth.js đều đặt `nameid: user._id` trong payload.

Mức độ ưu tiên: Cao — ảnh hưởng trực tiếp tới chức năng xóa comment.
