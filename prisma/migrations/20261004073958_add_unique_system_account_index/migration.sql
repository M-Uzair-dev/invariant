CREATE UNIQUE INDEX "Account_single_system_key" ON "Account"(type) WHERE type = 'SYSTEM';
