import "./instrument";
import { createApp } from "./app";

const bootstrap = async () => {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 5500));
};

bootstrap();
