import { mkdir, readFile, writeFile } from 'node:fs/promises';

async function main() {
  await mkdir('tmp', { recursive: true });

  const wallet = { owner: 'An', balance: 150 };
  await writeFile('tmp/wallet.json', JSON.stringify(wallet, null, 2));

  const text = await readFile('tmp/wallet.json', 'utf8');
  const loaded = JSON.parse(text);
  console.log(text);
  console.log(loaded.owner, loaded.balance);

  try {
    await readFile('tmp/khong-co.json', 'utf8');
  } catch (error) {
    console.log('lỗi đọc file:', error.code);
  }
}

main();
