export class EditDrafts {
  constructor(directory: string)
  folder(owner: string): string
  get(owner: string, target: string, key: string): any
  list(owner: string): any[]
  put(owner: string, target: string, key: string, value: any): void
  removeRef(owner: string, ref: any): void
  remove(owner: string, target: string, key: string): void
  locked<T>(owner: string, target: string, key: string, action: () => Promise<T>): Promise<T>
}
