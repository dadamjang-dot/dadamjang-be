import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { activityEvents, auditLogs } from "src/modules/database/schema";

@Injectable()
export class EventService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  recordActivity = async (
    actorUserId: string | null,
    eventType: string,
    subjectType: string,
    subjectId: string,
    payload: Record<string, unknown> = {},
  ) => {
    const [event] = await this.db
      .insert(activityEvents)
      .values({ actorUserId, eventType, subjectType, subjectId, payload })
      .returning();
    return event;
  };
  recordAudit = async (
    actorUserId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ) => {
    const [auditLog] = await this.db
      .insert(auditLogs)
      .values({ actorUserId, action, entityType, entityId, metadata })
      .returning();
    return auditLog;
  };
  listAuditLogs = () => this.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(100);
  listUserActivity = (userId: string) =>
    this.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.actorUserId, userId))
      .orderBy(desc(activityEvents.createdAt))
      .limit(100);
}
