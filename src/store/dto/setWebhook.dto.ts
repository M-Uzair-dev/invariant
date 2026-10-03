import { IsString, MaxLength } from 'class-validator';

export class SetWebhookDto {
  @IsString()
  @MaxLength(2048)
  url!: string;
}
