export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export function isSameUser(left: User, right: User): boolean {
  return left.id === right.id;
}
