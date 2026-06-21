-- AlterTable
ALTER TABLE "ProjectTag" ADD COLUMN     "currentRank" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "TagPositionHistory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagPositionHistory_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TagPositionHistory" ADD CONSTRAINT "TagPositionHistory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagPositionHistory" ADD CONSTRAINT "TagPositionHistory_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
