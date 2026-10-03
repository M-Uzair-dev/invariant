import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateNameDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
