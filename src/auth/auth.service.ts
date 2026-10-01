import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../utils/prisma/prisma.service';
import bcrypt from 'bcrypt';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { TokenService } from '../tokens/token.service';

const dummyHash =
  '$2b$12$BxK2k78g8U0SUbqEF24UoOSPNxmGvNB7LVNb3Mt4ASj09FP/dsIoO';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async userSignup(name: string, email: string, password: string) {
    try {
      const passwordHash = await bcrypt.hash(password, 12);

      const newUser = await this.prisma.user.create({
        data: {
          name,
          email: email.toLowerCase(),
          passwordHash,
          account: {
            create: {
              type: 'USER',
            },
          },
        },
      });
      const token = await this.tokenService.generateToken(newUser.id);
      return { token };
    } catch (e: any) {
      if (e instanceof PrismaClientKnownRequestError) {
        if (e.code === 'P2002') {
          throw new ConflictException('Email already in use.');
        }
      }
      throw e;
    }
  }

  async userLogin(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
      },
    });
    if (user) {
      const match = await bcrypt.compare(password, user.passwordHash);
      if (match) {
        const token = await this.tokenService.generateToken(user.id);
        return { token };
      } else {
        throw new UnauthorizedException('Invalid Credentials.');
      }
    } else {
      await bcrypt.compare('Correct Password, i swear', dummyHash);
      throw new UnauthorizedException('Invalid Credentials.');
    }
  }
}
