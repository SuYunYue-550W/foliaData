// 鲸鱼桌宠动画目录（来自 dsh-whale-pet 动画清单，95 条 / 16 类）
export interface WhalePetAnim { id: string; name: string; nameZh: string; category: string }
export const WHALE_PET_ANIMS: WhalePetAnim[] = [
 {
  "id": "breathing",
  "name": "breathing",
  "nameZh": "待机呼吸休闲",
  "category": "idle"
 },
 {
  "id": "looking_around",
  "name": "looking_around",
  "nameZh": "东张西望",
  "category": "turn"
 },
 {
  "id": "floating_steps",
  "name": "floating_steps",
  "nameZh": "原地漂浮踏步",
  "category": "moves"
 },
 {
  "id": "crab_walk",
  "name": "crab_walk",
  "nameZh": "螃蟹走路",
  "category": "moves"
 },
 {
  "id": "running_trip",
  "name": "running_trip",
  "nameZh": "原地左转奔跑摔跤",
  "category": "moves"
 },
 {
  "id": "target_point_run",
  "name": "target_point_run",
  "nameZh": "预备姿势奔跑",
  "category": "moves"
 },
 {
  "id": "happy_hop",
  "name": "happy_hop",
  "nameZh": "开心跃动",
  "category": "clicks"
 },
 {
  "id": "shy_surprise",
  "name": "shy_surprise",
  "nameZh": "害羞惊讶",
  "category": "clicks"
 },
 {
  "id": "tsundere_pout",
  "name": "tsundere_pout",
  "nameZh": "傲娇生气",
  "category": "clicks"
 },
 {
  "id": "ticklish_giggle",
  "name": "ticklish_giggle",
  "nameZh": "挠痒咯咯笑",
  "category": "clicks"
 },
 {
  "id": "cheerful_wave",
  "name": "cheerful_wave",
  "nameZh": "元气挥手",
  "category": "clicks"
 },
 {
  "id": "arrival_wave",
  "name": "arrival_wave",
  "nameZh": "原地挥手打招呼",
  "category": "clicks"
 },
 {
  "id": "dragged_in_midair",
  "name": "dragged_in_midair",
  "nameZh": "被鼠标拖拽悬空反馈",
  "category": "drag"
 },
 {
  "id": "turn_into_ball",
  "name": "turn_into_ball",
  "nameZh": "变成球",
  "category": "drag"
 },
 {
  "id": "maid_curtsy",
  "name": "maid_curtsy",
  "nameZh": "女仆屈膝礼仪",
  "category": "daily"
 },
 {
  "id": "big_stretch",
  "name": "big_stretch",
  "nameZh": "超大伸懒腰",
  "category": "daily"
 },
 {
  "id": "gentle_spin",
  "name": "gentle_spin",
  "nameZh": "小幅度原地旋转展示",
  "category": "daily"
 },
 {
  "id": "sleepy_yawn",
  "name": "sleepy_yawn",
  "nameZh": "哈欠连天",
  "category": "daily"
 },
 {
  "id": "quick_nap",
  "name": "quick_nap",
  "nameZh": "原地小憩沉眠",
  "category": "daily"
 },
 {
  "id": "startled_awake",
  "name": "startled_awake",
  "nameZh": "打瞌睡被惊醒",
  "category": "daily"
 },
 {
  "id": "morning_brushing",
  "name": "morning_brushing",
  "nameZh": "晨间刷牙",
  "category": "daily"
 },
 {
  "id": "mirror_check",
  "name": "mirror_check",
  "nameZh": "照镜子",
  "category": "daily"
 },
 {
  "id": "outfit_color_try_on",
  "name": "outfit_color_try_on",
  "nameZh": "整体换装试色",
  "category": "daily"
 },
 {
  "id": "attentive_listening",
  "name": "attentive_listening",
  "nameZh": "侧耳倾听",
  "category": "daily"
 },
 {
  "id": "taking_notes",
  "name": "taking_notes",
  "nameZh": "轻快记录文字",
  "category": "work"
 },
 {
  "id": "coding",
  "name": "coding",
  "nameZh": "写代码",
  "category": "work"
 },
 {
  "id": "deep_thought",
  "name": "deep_thought",
  "nameZh": "深度思考碎碎念",
  "category": "work"
 },
 {
  "id": "solving_a_rubiks_cube",
  "name": "solving_a_rubiks_cube",
  "nameZh": "专心玩魔方",
  "category": "games"
 },
 {
  "id": "playing_with_a_toy_car",
  "name": "playing_with_a_toy_car",
  "nameZh": "蹲下玩玩具汽车",
  "category": "games"
 },
 {
  "id": "gaming_rage",
  "name": "gaming_rage",
  "nameZh": "玩游戏气急败坏",
  "category": "games"
 },
 {
  "id": "water_gun_play",
  "name": "water_gun_play",
  "nameZh": "玩水枪",
  "category": "games"
 },
 {
  "id": "rocking_horse",
  "name": "rocking_horse",
  "nameZh": "骑木马",
  "category": "games"
 },
 {
  "id": "kicking_a_shuttlecock",
  "name": "kicking_a_shuttlecock",
  "nameZh": "踢毽子",
  "category": "games"
 },
 {
  "id": "spinning_a_top",
  "name": "spinning_a_top",
  "nameZh": "抽陀螺",
  "category": "games"
 },
 {
  "id": "playing_gomoku",
  "name": "playing_gomoku",
  "nameZh": "下五子棋",
  "category": "games"
 },
 {
  "id": "playground_swing",
  "name": "playground_swing",
  "nameZh": "荡秋千",
  "category": "games"
 },
 {
  "id": "carefree_humming",
  "name": "carefree_humming",
  "nameZh": "悠闲哼歌",
  "category": "music"
 },
 {
  "id": "playing_the_violin",
  "name": "playing_the_violin",
  "nameZh": "小提琴演奏",
  "category": "music"
 },
 {
  "id": "elegant_maid_dance",
  "name": "elegant_maid_dance",
  "nameZh": "优雅女仆舞",
  "category": "music"
 },
 {
  "id": "light_sway_dance",
  "name": "light_sway_dance",
  "nameZh": "轻快摇摆舞",
  "category": "music"
 },
 {
  "id": "cute_otaku_dance",
  "name": "cute_otaku_dance",
  "nameZh": "可爱宅舞",
  "category": "music"
 },
 {
  "id": "playing_the_flute",
  "name": "playing_the_flute",
  "nameZh": "吹笛子",
  "category": "music"
 },
 {
  "id": "eating_snacks",
  "name": "eating_snacks",
  "nameZh": "大口吃零食",
  "category": "food"
 },
 {
  "id": "caught_snacking",
  "name": "caught_snacking",
  "nameZh": "偷吃零食被抓住",
  "category": "food"
 },
 {
  "id": "eating_rice",
  "name": "eating_rice",
  "nameZh": "吃白饭",
  "category": "food"
 },
 {
  "id": "eating_breakfast",
  "name": "eating_breakfast",
  "nameZh": "吃早餐",
  "category": "food"
 },
 {
  "id": "eating_lunch",
  "name": "eating_lunch",
  "nameZh": "吃午餐",
  "category": "food"
 },
 {
  "id": "eating_dinner",
  "name": "eating_dinner",
  "nameZh": "吃晚餐",
  "category": "food"
 },
 {
  "id": "melting_ice_cream",
  "name": "melting_ice_cream",
  "nameZh": "吃冰淇淋融化",
  "category": "food"
 },
 {
  "id": "eating_watermelon",
  "name": "eating_watermelon",
  "nameZh": "吃西瓜",
  "category": "food"
 },
 {
  "id": "eating_hotpot",
  "name": "eating_hotpot",
  "nameZh": "涮火锅",
  "category": "food"
 },
 {
  "id": "eating_hairy_crab",
  "name": "eating_hairy_crab",
  "nameZh": "吃大闸蟹",
  "category": "food"
 },
 {
  "id": "eating_candied_haw",
  "name": "eating_candied_haw",
  "nameZh": "吃糖葫芦",
  "category": "food"
 },
 {
  "id": "eating_longevity_noodles",
  "name": "eating_longevity_noodles",
  "nameZh": "吃长寿面",
  "category": "food"
 },
 {
  "id": "moon_festival",
  "name": "moon_festival",
  "nameZh": "中秋赏月吃月饼",
  "category": "festivals"
 },
 {
  "id": "setting_off_fireworks",
  "name": "setting_off_fireworks",
  "nameZh": "放烟花",
  "category": "festivals"
 },
 {
  "id": "opening_a_gift",
  "name": "opening_a_gift",
  "nameZh": "拆礼物",
  "category": "festivals"
 },
 {
  "id": "eating_zongzi",
  "name": "eating_zongzi",
  "nameZh": "吃粽子",
  "category": "festivals"
 },
 {
  "id": "eating_tangyuan",
  "name": "eating_tangyuan",
  "nameZh": "吃汤圆",
  "category": "festivals"
 },
 {
  "id": "eating_dumplings",
  "name": "eating_dumplings",
  "nameZh": "吃饺子",
  "category": "festivals"
 },
 {
  "id": "eating_qingtuan",
  "name": "eating_qingtuan",
  "nameZh": "吃青团",
  "category": "festivals"
 },
 {
  "id": "eating_laba_congee",
  "name": "eating_laba_congee",
  "nameZh": "吃腊八粥",
  "category": "festivals"
 },
 {
  "id": "eating_rice_cake",
  "name": "eating_rice_cake",
  "nameZh": "吃年糕",
  "category": "festivals"
 },
 {
  "id": "eating_chongyang_cake",
  "name": "eating_chongyang_cake",
  "nameZh": "吃重阳糕",
  "category": "festivals"
 },
 {
  "id": "receiving_a_red_envelope",
  "name": "receiving_a_red_envelope",
  "nameZh": "收红包",
  "category": "festivals"
 },
 {
  "id": "lion_dance",
  "name": "lion_dance",
  "nameZh": "舞狮头",
  "category": "festivals"
 },
 {
  "id": "writing_the_fu_character",
  "name": "writing_the_fu_character",
  "nameZh": "写福字",
  "category": "festivals"
 },
 {
  "id": "qixi_needlework",
  "name": "qixi_needlework",
  "nameZh": "穿针乞巧",
  "category": "festivals"
 },
 {
  "id": "decorating_a_christmas_tree",
  "name": "decorating_a_christmas_tree",
  "nameZh": "装点圣诞树",
  "category": "festivals"
 },
 {
  "id": "halloween_trick_or_treat",
  "name": "halloween_trick_or_treat",
  "nameZh": "讨糖南瓜灯",
  "category": "festivals"
 },
 {
  "id": "chongyang_chrysanthemums",
  "name": "chongyang_chrysanthemums",
  "nameZh": "插茱萸赏菊",
  "category": "festivals"
 },
 {
  "id": "releasing_a_river_lantern",
  "name": "releasing_a_river_lantern",
  "nameZh": "放河灯",
  "category": "festivals"
 },
 {
  "id": "cute_little_ghost",
  "name": "cute_little_ghost",
  "nameZh": "萌化小幽灵",
  "category": "festivals"
 },
 {
  "id": "releasing_a_sky_lantern",
  "name": "releasing_a_sky_lantern",
  "nameZh": "放孔明灯",
  "category": "festivals"
 },
 {
  "id": "building_a_snowman",
  "name": "building_a_snowman",
  "nameZh": "堆雪人",
  "category": "seasonal"
 },
 {
  "id": "cooling_with_a_hand_fan",
  "name": "cooling_with_a_hand_fan",
  "nameZh": "摇扇纳凉",
  "category": "seasonal"
 },
 {
  "id": "buried_in_autumn_leaves",
  "name": "buried_in_autumn_leaves",
  "nameZh": "被落叶淹没",
  "category": "seasonal"
 },
 {
  "id": "flying_a_kite",
  "name": "flying_a_kite",
  "nameZh": "放风筝",
  "category": "seasonal"
 },
 {
  "id": "dove_magic",
  "name": "dove_magic",
  "nameZh": "变鸽子魔术",
  "category": "magic"
 },
 {
  "id": "flower_conjuring",
  "name": "flower_conjuring",
  "nameZh": "凭空生花魔术",
  "category": "magic"
 },
 {
  "id": "card_magic",
  "name": "card_magic",
  "nameZh": "扑克魔术",
  "category": "magic"
 },
 {
  "id": "inflating_a_balloon",
  "name": "inflating_a_balloon",
  "nameZh": "吹气球",
  "category": "fun"
 },
 {
  "id": "animal_parade",
  "name": "animal_parade",
  "nameZh": "动物环绕",
  "category": "fun"
 },
 {
  "id": "three_ball_juggling",
  "name": "three_ball_juggling",
  "nameZh": "三球抛接",
  "category": "fun"
 },
 {
  "id": "butterflies_and_blossoms",
  "name": "butterflies_and_blossoms",
  "nameZh": "蝴蝶蜜蜂环绕头顶开花",
  "category": "fun"
 },
 {
  "id": "petting_a_cat",
  "name": "petting_a_cat",
  "nameZh": "撸猫",
  "category": "fun"
 },
 {
  "id": "jump_and_smash",
  "name": "jump_and_smash",
  "nameZh": "原地跳跃抓碎头顶物品",
  "category": "fun"
 },
 {
  "id": "whale_bubbles",
  "name": "whale_bubbles",
  "nameZh": "鲸鱼吐泡泡特效",
  "category": "special"
 },
 {
  "id": "blue_whale_appears",
  "name": "blue_whale_appears",
  "nameZh": "蓝鲸现世",
  "category": "special"
 },
 {
  "id": "whale_tail_slap",
  "name": "whale_tail_slap",
  "nameZh": "用鲸鱼尾巴拍打地面",
  "category": "special"
 },
 {
  "id": "desk_tap",
  "name": "desk_tap",
  "nameZh": "敲击桌面互动",
  "category": "fun"
 },
 {
  "id": "gravity_squash",
  "name": "gravity_squash",
  "nameZh": "重力下蹲压缩",
  "category": "fun"
 },
 {
  "id": "jump_scare",
  "name": "jump_scare",
  "nameZh": "被吓一跳",
  "category": "fun"
 },
 {
  "id": "eating_tokens",
  "name": "eating_tokens",
  "nameZh": "吃 Token",
  "category": "memes"
 },
 {
  "id": "yeah_what_should_we_eat",
  "name": "yeah_what_should_we_eat",
  "nameZh": "是啊，吃什么？",
  "category": "memes"
 }
];
