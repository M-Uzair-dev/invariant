import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class StoreLoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
