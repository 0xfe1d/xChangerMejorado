-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('TELEGRAM');

-- CreateEnum
CREATE TYPE "RegistrationOrigin" AS ENUM ('WEB', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "LinkRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChannelChallengeKind" AS ENUM ('EMAIL_OTP', 'MFA');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WEB', 'TELEGRAM');

-- AlterTable
ALTER TABLE "pending_registrations" ADD COLUMN     "external_user_id" TEXT,
ADD COLUMN     "origin" "RegistrationOrigin" NOT NULL DEFAULT 'WEB',
ALTER COLUMN "password_hash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_enabled_at" TIMESTAMP(3),
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "login_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "otp_code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_sessions" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "channel_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_link_requests" (
    "id" TEXT NOT NULL,
    "device_code_hash" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "username" TEXT,
    "status" "LinkRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_polled_at" TIMESTAMP(3),

    CONSTRAINT "channel_link_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_login_challenges" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "kind" "ChannelChallengeKind" NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "user_id" TEXT,
    "otp_hash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "chat_messages" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id","channel")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_identities_channel_external_user_id_idx" ON "channel_identities"("channel", "external_user_id");

-- CreateIndex
CREATE INDEX "channel_identities_user_id_channel_idx" ON "channel_identities"("user_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "channel_sessions_refresh_token_hash_key" ON "channel_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "channel_sessions_family_id_idx" ON "channel_sessions"("family_id");

-- CreateIndex
CREATE INDEX "channel_sessions_identity_id_idx" ON "channel_sessions"("identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_link_requests_device_code_hash_key" ON "channel_link_requests"("device_code_hash");

-- CreateIndex
CREATE INDEX "channel_link_requests_user_code_status_idx" ON "channel_link_requests"("user_code", "status");

-- CreateIndex
CREATE UNIQUE INDEX "channel_login_challenges_jti_key" ON "channel_login_challenges"("jti");

-- CreateIndex
CREATE INDEX "outbox_published_at_id_idx" ON "outbox"("published_at", "id");

-- CreateIndex
CREATE INDEX "logs_user_id_timestamp_idx" ON "logs"("user_id", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "messages_offer_id_timestamp_idx" ON "messages"("offer_id", "timestamp");

-- CreateIndex
CREATE INDEX "messages_ticket_id_timestamp_idx" ON "messages"("ticket_id", "timestamp");

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_timestamp_idx" ON "notifications"("user_id", "is_read", "timestamp");

-- CreateIndex
CREATE INDEX "offers_status_asignatura_id_created_at_idx" ON "offers"("status", "asignatura_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "offers_user_id_idx" ON "offers"("user_id");

-- CreateIndex
CREATE INDEX "offers_accepted_by_id_idx" ON "offers"("accepted_by_id");

-- AddForeignKey
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "channel_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_link_requests" ADD CONSTRAINT "channel_link_requests_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariantes que Prisma no puede expresar ─────────────────────
-- Una sola identidad activa por (canal, usuario externo) y por (usuario, canal).
CREATE UNIQUE INDEX "channel_identities_active_external_key"
  ON "channel_identities" ("channel", "external_user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "channel_identities_active_user_key"
  ON "channel_identities" ("user_id", "channel") WHERE "revoked_at" IS NULL;

-- Un userCode solo puede estar activo (PENDING) una vez.
CREATE UNIQUE INDEX "channel_link_requests_pending_code_key"
  ON "channel_link_requests" ("user_code") WHERE "status" = 'PENDING';

-- AR-11: un mensaje pertenece exactamente a un ticket o a una oferta.
ALTER TABLE "messages" ADD CONSTRAINT "messages_exactly_one_parent"
  CHECK ((("ticket_id" IS NOT NULL)::int + ("offer_id" IS NOT NULL)::int) = 1);
