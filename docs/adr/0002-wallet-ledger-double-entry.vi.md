# ADR-0002: Ledger ghi sổ kép bất biến cho wallet

**Trạng thái:** Chấp nhận — 2026-10-09

## Bối cảnh

Wallet phải chống thanh toán trùng và chứng minh được số dư khớp với payment gateway.

## Quyết định

Mọi thay đổi tiền là bút toán chỉ-ghi-thêm với tổng nợ/có bằng 0. Số dư là cột cache cập nhật cùng transaction,
luôn kiểm chứng lại được từ sổ cái. Sai thì ghi bút toán đảo, không sửa dòng cũ. Không dùng event sourcing đầy đủ.

## Phương án đã loại

- Cột số dư + bảng giao dịch phẳng: đối soát yếu, lệch khó phát hiện.
- Event sourcing: vượt phạm vi, tăng chi phí vận hành.

## Hệ quả

Nhiều bảng và kỷ luật hơn, đổi lại đối soát và kiểm toán chính xác.
