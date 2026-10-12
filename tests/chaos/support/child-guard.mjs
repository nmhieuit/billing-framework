// Nạp trước main.ts của dịch vụ con (node --import): chống tiến trình mồ côi.
// Cha giữ đầu ghi của pipe stdin; cha chết (kể cả bị giết cứng) thì OS đóng pipe, con thấy 'end'/'close' và tự thoát.
// Không đổi hành vi dịch vụ: stdin được unref nên không giữ tiến trình sống.
const stdin = process.stdin;
const die = () => process.exit(137);
stdin.on('end', die);
stdin.on('close', die);
stdin.on('error', die);
stdin.resume();
stdin.unref?.();
