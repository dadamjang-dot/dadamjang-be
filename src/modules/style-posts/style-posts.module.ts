import { Module } from "@nestjs/common";
import { StylePostsResolver } from "./style-posts.resolver";
import { StylePostsService } from "./style-posts.service";

@Module({ providers: [StylePostsService, StylePostsResolver], exports: [StylePostsService] })
export class StylePostsModule {}
