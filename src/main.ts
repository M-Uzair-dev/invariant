import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // one hop: the ALB. req.ip = the client IP the ALB appended to
  // X-Forwarded-For (not a spoofable left-most entry), so rate limits key per client.
  app.set('trust proxy', 1);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
