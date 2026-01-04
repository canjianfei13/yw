import http2 from 'http2';
import protobuf from 'protobufjs';
import pako from 'pako';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url );
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================
const rawTokens = process.env.TOKENS || '';
const DEFAULT_TOKENS = ['在此填入默认Token(可选)'];
const TOKENS = rawTokens ? rawTokens.split(',').map(t => t.trim()).filter(t => t) : DEFAULT_TOKENS;

const CONFIG = {
  baseUrl: 'https://gacha.reamicro.zhendong.ltd',
  timeout: 15000,
  headers: {
    'user-agent': 'grpc-java-okhttp/1.73.0',
    'content-type': 'application/grpc',
    'te': 'trailers',
    'platform': 'compose',
    'alias': '1.3.0',
    'version': '130',
    'grpc-accept-encoding': 'gzip',
    'grpc-timeout': '1000000u'
  }
};

// ==================== gRPC 工具类 ====================
class GrpcClient {
  constructor(baseUrl, token ) {
    this.baseUrl = baseUrl;
    this.token = token.replace(/^Bearer\s+/i, '').replace(/^authorization:\s*Bearer\s+/i, '');
    this.client = null;
    this.root = null;
  }

  async loadProto() {
    const protos = ['adventure.proto', 'brand.proto', 'props.proto', 'player.proto', 'game.proto'];
    this.root = await protobuf.load(protos.map(p => path.join(__dirname, p)));
  }

  connect() {
    if (!this.client) {
      this.client = http2.connect(this.baseUrl );
      this.client.on('error', (err) => {}); // 忽略连接级错误，由请求捕获
    }
    return this.client;
  }

  encodeMessage(messageType, data) {
    const Message = this.root.lookupType(messageType);
    const buffer = Message.encode(Message.create(data)).finish();
    const lengthPrefix = Buffer.alloc(5);
    lengthPrefix.writeUInt8(0, 0);
    lengthPrefix.writeUInt32BE(buffer.length, 1);
    return Buffer.concat([lengthPrefix, buffer]);
  }

  decodeGrpcResponse(buffer) {
    const compressionFlag = buffer.readUInt8(0);
    let messageBuffer = buffer.slice(5);
    if (compressionFlag === 1 || (messageBuffer.length >= 2 && messageBuffer[0] === 0x1f && messageBuffer[1] === 0x8b)) {
      messageBuffer = pako.ungzip(messageBuffer);
    }
    return messageBuffer;
  }

  async call(service, method, requestType, responseType, data = {}) {
    return new Promise((resolve, reject) => {
      const client = this.connect();
      const req = client.request({
        ':method': 'POST',
        ':path': `/${service}/${method}`,
        ':scheme': 'https',
        ':authority': this.baseUrl.replace('https://', '' ),
        ...CONFIG.headers,
        'authorization': `Bearer ${this.token}`
      });

      const timer = setTimeout(() => { req.destroy(); reject(new Error('请求超时')); }, CONFIG.timeout);
      req.setEncoding('binary');
      let responseChunks = [];

      req.on('response', (headers) => {
        const status = headers['grpc-status'];
        if (status && status !== '0') {
          clearTimeout(timer);
          reject(new Error(`gRPC 错误 ${status}: ${headers['grpc-message'] || '未知'}`));
        }
      });

      req.on('data', (chunk) => responseChunks.push(Buffer.from(chunk, 'binary')));
      req.on('end', () => {
        clearTimeout(timer);
        try {
          const responseBuffer = Buffer.concat(responseChunks);
          if (responseBuffer.length === 0) return resolve({});
          const messageBuffer = this.decodeGrpcResponse(responseBuffer);
          resolve(this.root.lookupType(responseType).decode(messageBuffer).toJSON());
        } catch (error) { reject(error); }
      });

      req.on('error', (error) => { clearTimeout(timer); reject(error); });
      req.write(this.encodeMessage(requestType, data));
      req.end();
    });
  }

  close() { if (this.client) { this.client.close(); this.client = null; } }
}

// ==================== 辅助函数 ====================
function hasEnoughMaterials(myProps, requiredMaterials) {
  const propsMap = {};
  myProps.forEach(p => propsMap[String(p.id)] = parseInt(p.count || 0));
  for (const req of requiredMaterials) {
    if ((propsMap[String(req.id)] || 0) < parseInt(req.count)) return false;
  }
  return true;
}

// ==================== 业务逻辑模块 ====================
async function handleAdventure(client, userLabel) {
  const list = await client.call('api.adventure.Adventure', 'GetMyAdventureList', 'api.adventure.GetMyAdventureListRequest', 'api.adventure.GetMyAdventureListResponse');
  if (!list.data) return;
  for (const adv of list.data) {
    if (adv.status === 'IDLE') {
      await client.call('api.adventure.Adventure', 'AcceptAdventure', 'api.adventure.AcceptAdventureRequest', 'api.adventure.AcceptAdventureResponse', { id: adv.id });
      console.log(`${userLabel} 接受冒险: ${adv.title}`);
    } else if (adv.status === 'COMPLETED') {
      await client.call('api.adventure.Adventure', 'FinishAdventure', 'api.adventure.FinishAdventureRequest', 'api.adventure.FinishAdventureResponse', { id: adv.id });
      console.log(`${userLabel} 领取冒险奖励: ${adv.title}`);
    }
  }
}

async function handleMaking(client, userLabel) {
  const status = await client.call('api.props.Props', 'GetMyMakingV2', 'api.props.GetMyMakingV2Request', 'api.props.GetMyMakingV2Response');
  const now = Date.now();
  let canMakeNew = true;

  if (status.equipment?.length > 0) {
    for (const eq of status.equipment) {
      if (now >= Number(eq.validTime)) {
        await client.call('api.props.Props', 'FinishMakingV2', 'api.props.FinishMakingV2Request', 'api.props.FinishMakingV2Response', { id: eq.id });
        console.log(`${userLabel} 领取制作完成的装备: ${eq.name}`);
      } else {
        canMakeNew = false;
        console.log(`${userLabel} 装备制作中: ${eq.name}，剩余 ${Math.ceil((Number(eq.validTime) - now)/1000)}秒`);
      }
    }
  }

  if (canMakeNew) {
    const myProps = (await client.call('api.props.Props', 'GetMyProps', 'api.props.GetMyPropsRequest', 'api.props.GetMyPropsResponse')).data || [];
    const recipes = (await client.call('api.props.Props', 'GetMakingListV2', 'api.props.GetMakingListV2Request', 'api.props.GetMakingListV2Response')).data || [];
    for (const r of recipes) {
      if (hasEnoughMaterials(myProps, r.materials)) {
        await client.call('api.props.Props', 'MakeEquipmentV2', 'api.props.MakeEquipmentV2Request', 'api.props.MakeEquipmentV2Response', { id: r.id });
        console.log(`${userLabel} 材料充足，开始制作: ${r.name}`);
        break;
      }
    }
  }
}

async function handleGambling(client, userLabel) {
  const game = await client.call('api.game.Game', 'GetTodayGambling', 'api.game.GetTodayGamblingRequest', 'api.game.GetTodayGamblingResponse');
  if (game.canBet) {
    await client.call('api.game.Game', 'BetGambling', 'api.game.BetGamblingRequest', 'api.game.BetGamblingResponse', { id: game.id });
    console.log(`${userLabel} 勾栏投注成功`);
  }
}

// ==================== 用户处理入口 ====================
async function processUser(token, index) {
  const userLabel = `[用户 ${index + 1}]`;
  const client = new GrpcClient(CONFIG.baseUrl, token);
  try {
    await client.loadProto();
    await handleAdventure(client, userLabel);
    await handleMaking(client, userLabel);
    await handleGambling(client, userLabel);
  } catch (error) {
    console.error(`${userLabel} 运行出错: ${error.message}`);
  } finally {
    client.close();
  }
}

async function main() {
  console.log(`[${new Date().toLocaleString()}] 检测到 ${TOKENS.length} 个用户，开始并发处理...`);
  await Promise.all(TOKENS.map((t, i) => processUser(t, i)));
  console.log(`[${new Date().toLocaleString()}] 所有用户处理完毕。`);
}

main().catch(console.error);
