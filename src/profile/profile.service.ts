import { BadRequestException, Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { PrismaService } from '../utils/prisma/prisma.service';
import { UserType } from '../types/userRolesType';

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async updateName(type: UserType, id: string, name: string) {
    if (type === 'USER') {
      await this.prisma.user.update({ where: { id }, data: { name } });
    } else {
      await this.prisma.store.update({ where: { id }, data: { name } });
    }
    return { name };
  }

  async changePassword(
    type: UserType,
    id: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const select = { passwordHash: true } as const;
    const subject =
      type === 'USER'
        ? await this.prisma.user.findUnique({ where: { id }, select })
        : await this.prisma.store.findUnique({ where: { id }, select });

    if (
      !subject ||
      !(await bcrypt.compare(currentPassword, subject.passwordHash))
    ) {
      throw new BadRequestException('Current password is incorrect.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    if (type === 'USER') {
      await this.prisma.user.update({ where: { id }, data: { passwordHash } });
    } else {
      await this.prisma.store.update({ where: { id }, data: { passwordHash } });
    }
  }
}
