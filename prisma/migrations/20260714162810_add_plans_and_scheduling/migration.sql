/*
  Warnings:

  - Added the required column `passwordHash` to the `User` table without a default value. This is not possible if the table is not empty.
  - Made the column `email` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('IDLE', 'PENDING', 'PROCESSING');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'DAILY_FRESH', 'PRO_STREAM');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "analysisStatus" "AnalysisStatus" NOT NULL DEFAULT 'IDLE',
ADD COLUMN     "lastAnalyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ProjectTag" ADD COLUMN     "onChart" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordHash" TEXT NOT NULL,
ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'FREE',
ALTER COLUMN "email" SET NOT NULL;
