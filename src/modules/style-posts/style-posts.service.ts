import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, lt } from "drizzle-orm";
import { CustomBadRequestException, CustomNotFoundException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { stylePosts } from "src/modules/database/schema";
import { StylePostErrorMessage } from "./style-posts.error";
import { CreateStylePostInput, StylePostConnectionType, StylePostType } from "./style-posts.types";

type StylePostCursor = { createdAt: string; stylePostId: string };
const MAX_PAGE_SIZE = 50;

const encodeCursor = (cursor: StylePostCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeCursor = (cursor: string): StylePostCursor => {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as StylePostCursor;
    if (!value.createdAt || !value.stylePostId || Number.isNaN(Date.parse(value.createdAt))) throw new Error("invalid");
    return value;
  } catch {
    throw new CustomBadRequestException(StylePostErrorMessage.InvalidCursor);
  }
};

@Injectable()
export class StylePostsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  create = async (authorId: string, isPartner: boolean, input: CreateStylePostInput): Promise<StylePostType> => {
    const [post] = await this.db
      .insert(stylePosts)
      .values({
        authorId,
        title: input.title,
        content: input.content,
        imageUrls: input.imageUrls,
        isPartner,
      })
      .returning();
    return this.toType(post);
  };

  get = async (stylePostId: string): Promise<StylePostType> => {
    const [post] = await this.db.select().from(stylePosts).where(eq(stylePosts.stylePostId, stylePostId)).limit(1);
    if (!post) throw new CustomNotFoundException(StylePostErrorMessage.NotFound);
    return this.toType(post);
  };

  list = async (after?: string, first?: number): Promise<StylePostConnectionType> => {
    const pageSize = Math.min(Math.max(first ?? 20, 1), MAX_PAGE_SIZE);
    const cursor = after ? decodeCursor(after) : undefined;
    const query = cursor
      ? this.db
          .select()
          .from(stylePosts)
          .where(lt(stylePosts.createdAt, new Date(cursor.createdAt)))
      : this.db.select().from(stylePosts);
    const rows = await query.orderBy(desc(stylePosts.createdAt), desc(stylePosts.stylePostId)).limit(pageSize + 1);
    const nodes = rows.slice(0, pageSize).map((row) => this.toType(row));
    const hasNextPage = rows.length > pageSize;
    const tail = nodes[nodes.length - 1];
    return {
      nodes,
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? encodeCursor({ createdAt: tail.createdAt.toISOString(), stylePostId: tail.stylePostId })
          : null,
    };
  };

  private toType = (row: typeof stylePosts.$inferSelect): StylePostType => ({ ...row });
}
