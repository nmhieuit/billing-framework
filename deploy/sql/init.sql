-- Chạy bằng sqlcmd với -v WALLET_DB_PASSWORD=... PAYMENT_DB_PASSWORD=... WALLET_MIGRATOR_PASSWORD=... PAYMENT_MIGRATOR_PASSWORD=...
-- Tạo DB và tài khoản riêng cho từng service; chạy lại nhiều lần không lỗi.

IF DB_ID(N'billing_wallet') IS NULL CREATE DATABASE [billing_wallet];
GO
IF DB_ID(N'billing_payment') IS NULL CREATE DATABASE [billing_payment];
GO

IF SUSER_ID(N'billing_wallet_app') IS NULL
  CREATE LOGIN [billing_wallet_app] WITH PASSWORD = N'$(WALLET_DB_PASSWORD)', CHECK_POLICY = OFF;
GO
IF SUSER_ID(N'billing_payment_app') IS NULL
  CREATE LOGIN [billing_payment_app] WITH PASSWORD = N'$(PAYMENT_DB_PASSWORD)', CHECK_POLICY = OFF;
GO
IF SUSER_ID(N'billing_wallet_migrator') IS NULL
  CREATE LOGIN [billing_wallet_migrator] WITH PASSWORD = N'$(WALLET_MIGRATOR_PASSWORD)', CHECK_POLICY = OFF;
GO
IF SUSER_ID(N'billing_payment_migrator') IS NULL
  CREATE LOGIN [billing_payment_migrator] WITH PASSWORD = N'$(PAYMENT_MIGRATOR_PASSWORD)', CHECK_POLICY = OFF;
GO

USE [billing_wallet];
GO
IF USER_ID(N'billing_wallet_app') IS NULL CREATE USER [billing_wallet_app] FOR LOGIN [billing_wallet_app];
GO
ALTER ROLE db_datareader ADD MEMBER [billing_wallet_app];
ALTER ROLE db_datawriter ADD MEMBER [billing_wallet_app];
-- Login ứng dụng chỉ DML: thu hồi db_ddladmin nếu bản init cũ đã cấp (không để app tắt/xóa trigger bất biến).
IF IS_ROLEMEMBER(N'db_ddladmin', N'billing_wallet_app') = 1 ALTER ROLE db_ddladmin DROP MEMBER [billing_wallet_app];
IF USER_ID(N'billing_wallet_migrator') IS NULL CREATE USER [billing_wallet_migrator] FOR LOGIN [billing_wallet_migrator];
ALTER ROLE db_owner ADD MEMBER [billing_wallet_migrator];
GO

USE [billing_payment];
GO
IF USER_ID(N'billing_payment_app') IS NULL CREATE USER [billing_payment_app] FOR LOGIN [billing_payment_app];
GO
ALTER ROLE db_datareader ADD MEMBER [billing_payment_app];
ALTER ROLE db_datawriter ADD MEMBER [billing_payment_app];
-- Login ứng dụng chỉ DML: thu hồi db_ddladmin nếu bản init cũ đã cấp (không để app tắt/xóa trigger bất biến).
IF IS_ROLEMEMBER(N'db_ddladmin', N'billing_payment_app') = 1 ALTER ROLE db_ddladmin DROP MEMBER [billing_payment_app];
IF USER_ID(N'billing_payment_migrator') IS NULL CREATE USER [billing_payment_migrator] FOR LOGIN [billing_payment_migrator];
ALTER ROLE db_owner ADD MEMBER [billing_payment_migrator];
GO
