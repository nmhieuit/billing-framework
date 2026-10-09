-- Chạy bằng sqlcmd với -v WALLET_DB_PASSWORD=... PAYMENT_DB_PASSWORD=...
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

USE [billing_wallet];
GO
IF USER_ID(N'billing_wallet_app') IS NULL CREATE USER [billing_wallet_app] FOR LOGIN [billing_wallet_app];
GO
ALTER ROLE db_datareader ADD MEMBER [billing_wallet_app];
ALTER ROLE db_datawriter ADD MEMBER [billing_wallet_app];
ALTER ROLE db_ddladmin ADD MEMBER [billing_wallet_app];
GO

USE [billing_payment];
GO
IF USER_ID(N'billing_payment_app') IS NULL CREATE USER [billing_payment_app] FOR LOGIN [billing_payment_app];
GO
ALTER ROLE db_datareader ADD MEMBER [billing_payment_app];
ALTER ROLE db_datawriter ADD MEMBER [billing_payment_app];
ALTER ROLE db_ddladmin ADD MEMBER [billing_payment_app];
GO
