// bcrypt-pbkdf (ssh2 가 쓰는 것과 같은 순수 JS 구현)의 타입
declare module 'bcrypt-pbkdf' {
  const bcrypt: {
    pbkdf(pass: Uint8Array, passlen: number, salt: Uint8Array, saltlen: number, key: Uint8Array, keylen: number, rounds: number): number;
  };
  export default bcrypt;
}
