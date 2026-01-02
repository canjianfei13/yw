import http2 from 'http2';
import protobuf from 'protobufjs';
import pako from 'pako';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================
const TOKEN = 'authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjI2NDMzLCJNYXBDbGFpbXMiOnt9fQ.faF4-GduXX_ZUfDdp9wnljFl3F7hPHoj8_ogzS8Whoc';

const ENABLE_GAMBLING = true;

const CONFIG = {
  baseUrl: 'https://gacha.reamicro.zhendong.ltd',
  timeout: 5000,
  headers: {
    'user-agent': 'grpc-java-okhttp/1.73.0',
    'content-type': 'application/grpc',
    'te': 'trailers',
    'platform': 'compose',
    'alias': '1.3.0',
    'version': '130',
    'grpc-accept-encoding': 'gzip',
    'grpc-timeout': '469039u'
  }
};

// ==================== gRPC 工具类 ====================
class GrpcClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.client = null;
    this.root = null;
  }

  async loadProto() {
    const adventurePath = path.join(__dirname, 'adventure.proto');
    const brandPath = path.join(__dirname, 'brand.proto');
    const propsPath = path.join(__dirname, 'props.proto');
    const playerPath = path.join(__dirname, 'player.proto');
    const gamePath = path.join(__dirname, 'game.proto');
    this.root = await protobuf.load([adventurePath, brandPath, propsPath, playerPath, gamePath]);
  }

  connect() {
    if (!this.client) {
      this.client = http2.connect(this.baseUrl);
      this.client.on('error', (err) => {
        console.error('HTTP/2 连接错误:', err);
      });
    }
    return this.client;
  }

  encodeMessage(messageType, data) {
    const Message = this.root.lookupType(messageType);
    const message = Message.create(data);
    const buffer = Message.encode(message).finish();

    const lengthPrefix = Buffer.alloc(5);
    lengthPrefix.writeUInt8(0, 0);
    lengthPrefix.writeUInt32BE(buffer.length, 1);

    return Buffer.concat([lengthPrefix, buffer]);
  }

  decodeGrpcResponse(buffer) {
    const compressionFlag = buffer.readUInt8(0);
    let messageBuffer = buffer.slice(5);

    if (compressionFlag === 1) {
      messageBuffer = pako.ungzip(messageBuffer);
    } else if (messageBuffer.length >= 2 && messageBuffer[0] === 0x1f && messageBuffer[1] === 0x8b) {
      messageBuffer = pako.ungzip(messageBuffer);
    }

    return messageBuffer;
  }

  async call(service, method, requestType, responseType, data = {}) {
    return new Promise((resolve, reject) => {
      const client = this.connect();
      const path = `/${service}/${method}`;

      const requestBody = this.encodeMessage(requestType, data);

      const req = client.request({
        ':method': 'POST',
        ':path': path,
        ':scheme': 'https',
        ':authority': this.baseUrl.replace('https://', ''),
        ...CONFIG.headers,
        'authorization': `Bearer ${this.token}`
      });

      const timeout = setTimeout(() => {
        req.destroy();
        reject(new Error('请求超时'));
      }, CONFIG.timeout);

      req.setEncoding('binary');
      let responseChunks = [];

      req.on('response', (headers) => {
        const grpcStatus = headers['grpc-status'];
        const grpcMessage = headers['grpc-message'];

        if (grpcStatus && grpcStatus !== '0') {
          clearTimeout(timeout);
          reject(new Error(`gRPC 错误 ${grpcStatus}: ${grpcMessage || '未知错误'}`));
          return;
        }
      });

      req.on('data', (chunk) => {
        responseChunks.push(Buffer.from(chunk, 'binary'));
      });

      req.on('end', () => {
        clearTimeout(timeout);

        try {
          const responseBuffer = Buffer.concat(responseChunks);

          if (responseBuffer.length === 0) {
            resolve({});
            return;
          }

          const messageBuffer = this.decodeGrpcResponse(responseBuffer);

          const Message = this.root.lookupType(responseType);
          const response = Message.decode(messageBuffer);

          resolve(response.toJSON());
        } catch (error) {
          reject(error);
        }
      });

      req.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      req.write(requestBody);
      req.end();
    });
  }

  close() {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}

// ==================== 辅助函数 ====================
function hasEnoughMaterials(myProps, requiredProps) {
  const propsMap = {};
  if (myProps && myProps.length > 0) {
    for (const prop of myProps) {
      const id = String(prop.id);
      propsMap[id] = (propsMap[id] || 0) + parseInt(prop.count || 0);
    }
  }

  for (const req of requiredProps) {
    const id = String(req.id);
    const required = parseInt(req.count || 0);
    const owned = propsMap[id] || 0;
    if (owned < required) {
      return false;
    }
  }
  return true;
}

// ==================== 主函数 ====================
async function main() {
  const grpcClient = new GrpcClient(CONFIG.baseUrl, TOKEN);

  try {
    await grpcClient.loadProto();
    grpcClient.connect();

    // ==================== 冒险功能 ====================
    console.log('=== 冒险任务 ===\n');

    const adventureList = await grpcClient.call(
      'api.adventure.Adventure',
      'GetMyAdventureList',
      'api.adventure.GetMyAdventureListRequest',
      'api.adventure.GetMyAdventureListResponse',
      {}
    );

    if (adventureList.data && adventureList.data.length > 0) {
      console.log(`找到 ${adventureList.data.length} 个冒险任务:`);

      for (const adventure of adventureList.data) {
        console.log(`\n冒险 #${adventure.id} - ${adventure.title}`);
        console.log(`    状态: ${adventure.status}`);
        console.log(`    时长: ${adventure.duration}秒`);

        const rewards = [];
        if (adventure.exp) rewards.push(`经验${adventure.exp}`);
        if (adventure.coin) rewards.push(`铜钱${adventure.coin}`);
        if (adventure.gem) rewards.push(`彩晶${adventure.gem}`);
        if (adventure.propsList && adventure.propsList.length > 0) {
          const items = adventure.propsList.map(p => `${p.name}x${p.count}`).join(', ');
          rewards.push(items);
        }
        console.log(`    奖励: ${rewards.length > 0 ? rewards.join(', ') : '无'}`);

        if (adventure.status === 'IDLE') {
          console.log(`    >>> 接受冒险...`);
          try {
            await grpcClient.call(
              'api.adventure.Adventure',
              'AcceptAdventure',
              'api.adventure.AcceptAdventureRequest',
              'api.adventure.AcceptAdventureResponse',
              { id: adventure.id }
            );
            console.log(`    ✓ 冒险已接受`);
          } catch (error) {
            console.log(`    ✗ 接受失败: ${error.message}`);
          }
        } else if (adventure.status === 'COMPLETED') {
          console.log(`    >>> 领取奖励...`);
          try {
            await grpcClient.call(
              'api.adventure.Adventure',
              'FinishAdventure',
              'api.adventure.FinishAdventureRequest',
              'api.adventure.FinishAdventureResponse',
              { id: adventure.id }
            );
            console.log(`    ✓ 奖励已领取`);

            const updatedList = await grpcClient.call(
              'api.adventure.Adventure',
              'GetMyAdventureList',
              'api.adventure.GetMyAdventureListRequest',
              'api.adventure.GetMyAdventureListResponse',
              {}
            );
            const updatedAdventure = updatedList.data?.find(a => a.id === adventure.id);

            if (!updatedAdventure) {
              console.log(`    >>> 冒险已完成，检查新冒险...`);
              // 检查是否有新的IDLE冒险
              const newIdleAdventure = updatedList.data?.find(a => a.status === 'IDLE');
              if (newIdleAdventure) {
                console.log(`    >>> 发现新冒险 #${newIdleAdventure.id}，正在接受...`);
                try {
                  await grpcClient.call(
                    'api.adventure.Adventure',
                    'AcceptAdventure',
                    'api.adventure.AcceptAdventureRequest',
                    'api.adventure.AcceptAdventureResponse',
                    { id: newIdleAdventure.id }
                  );
                  console.log(`    ✓ 冒险已接受`);
                } catch (error) {
                  console.log(`    ✗ 接受失败: ${error.message}`);
                }
              }
            } else if (updatedAdventure.status === 'IDLE') {
              console.log(`    >>> 继续接受...`);
              try {
                await grpcClient.call(
                  'api.adventure.Adventure',
                  'AcceptAdventure',
                  'api.adventure.AcceptAdventureRequest',
                  'api.adventure.AcceptAdventureResponse',
                  { id: adventure.id }
                );
                console.log(`    ✓ 冒险已接受`);
              } catch (error) {
                console.log(`    ✗ 接受失败: ${error.message}`);
              }
            }
          } catch (error) {
            console.log(`    ✗ 领取失败: ${error.message}`);
          }
        }
      }
    } else {
      console.log('当前没有可用的冒险任务');
    }

    // ==================== 制作装备功能 ====================
    console.log('\n\n=== 制作装备 ===\n');

    // 第一步：检查正在制作的装备
    const makingV2Result = await grpcClient.call(
      'api.props.Props',
      'GetMyMakingV2',
      'api.props.GetMyMakingV2Request',
      'api.props.GetMyMakingV2Response',
      {}
    );

    let shouldMakeNew = true;

    if (makingV2Result.equipment && makingV2Result.equipment.length > 0) {
      console.log(`找到 ${makingV2Result.equipment.length} 个正在制作的装备:`);
      const now = Date.now();

      for (const eq of makingV2Result.equipment) {
        console.log(`\n#${eq.id} - ${eq.name}`);
        if (eq.validTime) {
          const validTime = Number(eq.validTime);
          const validDate = new Date(validTime);
          console.log(`    完成时间: ${validDate.toLocaleString()}`);

          if (validTime <= now) {
            console.log(`    >>> 装备已完成，正在领取...`);
            try {
              await grpcClient.call(
                'api.props.Props',
                'FinishMakingEquipment',
                'api.props.FinishMakingEquipmentRequest',
                'api.props.FinishMakingEquipmentResponse',
                { id: eq.id }
              );
              console.log(`    ✓ 装备已领取！`);
            } catch (error) {
              console.log(`    ✗ 领取失败: ${error.message}`);
            }
          } else {
            const remaining = Math.ceil((validTime - now) / 1000);
            console.log(`    正在制作中，剩余 ${remaining} 秒`);
            shouldMakeNew = false;
          }
        }
      }
    } else {
      console.log('当前没有正在制作的装备');
    }

    // 第二步：制作新装备
    if (shouldMakeNew) {
      console.log('\n\n>>> 准备制作新装备...');

      const blueprintResult = await grpcClient.call(
        'api.props.Props',
        'GetMyBlueprint',
        'api.props.GetMyBlueprintRequest',
        'api.props.GetMyBlueprintResponse',
        {}
      );

      if (blueprintResult.data && blueprintResult.data.length > 0) {
        // 获取我的材料
        const myPropsResult = await grpcClient.call(
          'api.props.Props',
          'GetMyProps',
          'api.props.GetMyPropsRequest',
          'api.props.GetMyPropsResponse',
          { pageNum: 1, pageSize: 100 }
        );

        const myPropsList = myPropsResult.list || [];

        for (const bp of blueprintResult.data) {
          console.log(`\n检查蓝图: #${bp.id} - ${bp.name}`);

          if (bp.props && bp.props.length > 0) {
            const props = bp.props.map(p => `${p.name}x${p.count}`).join(', ');
            console.log(`    材料: ${props}`);

            // 检查材料是否足够
            if (hasEnoughMaterials(myPropsList, bp.props)) {
              console.log(`    >>> 材料足够，开始制作...`);
              try {
                await grpcClient.call(
                  'api.props.Props',
                  'MakeEquipment',
                  'api.props.MakeEquipmentRequest',
                  'api.props.MakeEquipmentResponse',
                  { blueprintId: Number(bp.id) }
                );
                console.log(`    ✓ 制作成功！`);
                break; // 制作一个后退出
              } catch (error) {
                console.log(`    ✗ 制作失败: ${error.message}`);
              }
            }
          }
        }
      }
    }

    // ==================== 人物属性 ====================
    console.log('\n\n=== 人物属性 ===\n');

    const belongingsResult = await grpcClient.call(
      'api.player.Player',
      'GetMyBelongings',
      'api.player.EmptyRequest',
      'api.player.MyBelongings',
      {}
    );

    console.log(`等级: ${belongingsResult.level}`);
    console.log(`经验: ${belongingsResult.exp} / ${belongingsResult.expMax}`);

    const currency = [];
    if (belongingsResult.coin) currency.push(`铜钱:${belongingsResult.coin}`);
    if (belongingsResult.crystal) currency.push(`水晶:${belongingsResult.crystal}`);
    if (belongingsResult.gem) currency.push(`彩晶:${belongingsResult.gem}`);
    if (belongingsResult.deposit) currency.push(`存款:${belongingsResult.deposit}`);
    if (currency.length > 0) console.log(`货币: ${currency.join(' | ')}`);

    const baseStats = [];
    if (belongingsResult.affinity) baseStats.push(`五行:${belongingsResult.affinity}`);
    if (belongingsResult.focus) baseStats.push(`思绪:${belongingsResult.focus/10}`);
    if (belongingsResult.luck) baseStats.push(`福缘:${belongingsResult.luck/10}`);
    if (belongingsResult.reputation) baseStats.push(`风评:${belongingsResult.reputation/10}`);
    if (baseStats.length > 0) console.log(`基础属性: ${baseStats.join(' | ')}`);

    const skills = [];
    if (belongingsResult.brushLevel) skills.push(`制笔 LV.${belongingsResult.brushLevel} (${belongingsResult.brushExp}/${belongingsResult.brushExpMax})`);
    if (belongingsResult.fanLevel) skills.push(`制扇 LV.${belongingsResult.fanLevel} (${belongingsResult.fanExp}/${belongingsResult.fanExpMax})`);
    if (belongingsResult.inkStoneLevel) skills.push(`制砚 LV.${belongingsResult.inkStoneLevel} (${belongingsResult.inkStoneExp}/${belongingsResult.inkStoneExpMax})`);
    if (skills.length > 0) console.log(`技能等级:`);
    skills.forEach(skill => console.log(`    ${skill}`));

    const efficiency = [];
    if (belongingsResult.brushEfficiency) efficiency.push(`制笔效率:${belongingsResult.brushEfficiency/10}`);
    if (belongingsResult.fanEfficiency) efficiency.push(`制扇效率:${belongingsResult.fanEfficiency/10}`);
    if (belongingsResult.inkStoneEfficiency) efficiency.push(`制砚效率:${belongingsResult.inkStoneEfficiency/10}`);
    if (efficiency.length > 0) console.log(`技巧: ${efficiency.join(' | ')}`);

    const special = [];
    if (belongingsResult.divination) special.push(`卜筮:${belongingsResult.divination}`);
    if (belongingsResult.fortune) special.push(`禄马:${belongingsResult.fortune}`);
    if (belongingsResult.spiritWeave) special.push(`灵衍:${belongingsResult.spiritWeave}`);
    if (belongingsResult.ruinBreak) special.push(`煞破:${belongingsResult.ruinBreak/10}`);
    if (special.length > 0) console.log(`特殊: ${special.join(' | ')}`);

    const other = [];
    if (belongingsResult.brand) other.push(`品牌:${belongingsResult.brand}`);
    if (belongingsResult.carteId) other.push(`名刺ID:${belongingsResult.carteId}`);
    if (belongingsResult.buffId) other.push(`BuffID:${belongingsResult.buffId}`);
    if (other.length > 0) console.log(`其他: ${other.join(' | ')}`);

    // ==================== 勾栏功能 ====================
    if (ENABLE_GAMBLING) {
      console.log('\n\n=== 勾栏 ===\n');

      const formatDate = (ts) => {
        const num = Number(ts);
        if (num > 10000000000) {
          return new Date(num).toLocaleString();
        } else {
          return new Date(num * 1000).toLocaleString();
        }
      };

      const todayResult = await grpcClient.call(
        'api.game.Game',
        'GetTodyGambling',
        'api.game.EmptyRequest',
        'api.game.Gambling',
        {}
      );

      if (todayResult.id) {
        console.log(`勾栏: #${todayResult.id} - ${todayResult.name}`);
        console.log(`奖金池: ${todayResult.prize}`);
        console.log(`参与人数: ${todayResult.people}`);

        const time = [];
        if (todayResult.startTime) time.push(`开始时间: ${formatDate(todayResult.startTime)}`);
        if (todayResult.endTime) time.push(`结束时间: ${formatDate(todayResult.endTime)}`);
        if (time.length > 0) console.log(`时间:`);
        time.forEach(t => console.log(`    ${t}`));

        const parseRank = (rankStr) => {
          if (!rankStr) return null;
          const parts = rankStr.split(',');
          return { id: parts[0], name: parts[1], score: parts[2], time: parts[3] };
        };

        if (todayResult.first) {
          const first = parseRank(todayResult.first);
          console.log(`第一名: ${first.name} (分数:${first.score})`);
        }
        if (todayResult.second) {
          const second = parseRank(todayResult.second);
          console.log(`第二名: ${second.name} (分数:${second.score})`);
        }
        if (todayResult.third) {
          const third = parseRank(todayResult.third);
          console.log(`第三名: ${third.name} (分数:${third.score})`);
        }

        console.log(`可投注: ${todayResult.canBet ? '是' : '否'}`);
        console.log(`奖励状态: ${todayResult.rewardStatus ?? '未开奖'}`);

        // 投注
        if (todayResult.canBet) {
          console.log('\n>>> 投注...');
          try {
            const betResult = await grpcClient.call(
              'api.game.Game',
              'BetGambling',
              'api.game.BetGamblingRequest',
              'api.game.BetGamblingResponse',
              { id: todayResult.id }
            );
            if (betResult.info) console.log(`点数: ${betResult.info}`);
            if (betResult.gambling) {
              console.log(`✓ 投注成功 (人数:${betResult.gambling.people}, 奖金池:${betResult.gambling.prize})`);
            }
          } catch (error) {
            console.log(`✗ 投注失败: ${error.message}`);
          }
        }

        // 领取奖励
        if (todayResult.rewardStatus && todayResult.rewardStatus > 0) {
          console.log('\n>>> 领取奖励...');
          try {
            const rewardResult = await grpcClient.call(
              'api.game.Game',
              'GetGamblingReward',
              'api.game.GetGamblingRewardRequest',
              'api.game.Gambling',
              { id: todayResult.id }
            );
            if (rewardResult.rewardStatus > 0) {
              console.log(`✓ 已领取奖励`);
            } else {
              console.log(`✗ 无可领取奖励`);
            }
          } catch (error) {
            console.log(`✗ 领取失败: ${error.message}`);
          }
        }
      }
    }

  } catch (error) {
    console.error('发生错误:', error.message);
    console.error(error.stack);
  } finally {
    grpcClient.close();
  }
}

main().catch(console.error);
