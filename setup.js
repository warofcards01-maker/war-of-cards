import { randomBytes } from 'node:crypto';
import { existsSync,writeFileSync } from 'node:fs';
if(existsSync('.env')) {
  console.log('.env already exists. Existing credentials have been kept.');
  process.exit(0);
}
const password='Pr!'+randomBytes(18).toString('base64url');
writeFileSync('.env',`PORT=3000\nDATA_DIR=./data\nADMIN_ID=owner\nADMIN_PASSWORD=${password}\nTRUST_PROXY=false\nNODE_ENV=development\nSUPPORT_NUMBER=\n`,{mode:0o600,flag:'wx'});
console.log('WAR OF CARDS setup complete. Keep these credentials private.');
console.log('Admin ID: owner');
console.log('Admin Password: '+password);
console.log('Run npm start, then open http://localhost:3000/admin');
console.log('The password is used to create the admin only on the first database launch.');
