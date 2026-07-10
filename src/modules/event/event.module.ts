import { Module } from "@nestjs/common";
import { EventResolver } from "./event.resolver";
import { EventService } from "./event.service";

@Module({ providers: [EventService, EventResolver], exports: [EventService] })
export class EventModule {}
