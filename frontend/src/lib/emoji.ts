// Common emoji dataset -- top ~500 emoji with colon codes
const EMOJI_MAP: Record<string, string> = {
  'smile': '\u{1F604}', 'laughing': '\u{1F606}', 'blush': '\u{1F60A}',
  'smiley': '\u{1F603}', 'relaxed': '\u{263A}\u{FE0F}', 'smirk': '\u{1F60F}',
  'heart_eyes': '\u{1F60D}', 'kissing_heart': '\u{1F618}', 'wink': '\u{1F609}',
  'stuck_out_tongue_winking_eye': '\u{1F61C}', 'stuck_out_tongue': '\u{1F61B}',
  'flushed': '\u{1F633}', 'grin': '\u{1F601}', 'pensive': '\u{1F614}',
  'relieved': '\u{1F60C}', 'unamused': '\u{1F612}', 'disappointed': '\u{1F61E}',
  'persevere': '\u{1F623}', 'cry': '\u{1F622}', 'joy': '\u{1F602}',
  'sob': '\u{1F62D}', 'sleepy': '\u{1F62A}', 'sweat': '\u{1F613}',
  'cold_sweat': '\u{1F630}', 'weary': '\u{1F629}', 'tired_face': '\u{1F62B}',
  'fearful': '\u{1F628}', 'scream': '\u{1F631}', 'angry': '\u{1F620}',
  'rage': '\u{1F621}', 'triumph': '\u{1F624}', 'confounded': '\u{1F616}',
  'sunglasses': '\u{1F60E}', 'confused': '\u{1F615}', 'hushed': '\u{1F62F}',
  'expressionless': '\u{1F611}', 'mask': '\u{1F637}', 'no_mouth': '\u{1F636}',
  'innocent': '\u{1F607}', 'alien': '\u{1F47D}', 'thumbsup': '\u{1F44D}',
  'thumbsdown': '\u{1F44E}', 'ok_hand': '\u{1F44C}', 'punch': '\u{1F44A}',
  'fist': '\u{270A}', 'v': '\u{270C}\u{FE0F}', 'wave': '\u{1F44B}',
  'hand': '\u{270B}', 'clap': '\u{1F44F}', 'muscle': '\u{1F4AA}',
  'pray': '\u{1F64F}', 'point_up': '\u{261D}\u{FE0F}', 'point_down': '\u{1F447}',
  'point_left': '\u{1F448}', 'point_right': '\u{1F449}', 'fire': '\u{1F525}',
  'heart': '\u{2764}\u{FE0F}', 'broken_heart': '\u{1F494}', 'star': '\u{2B50}',
  'sparkles': '\u{2728}', 'tada': '\u{1F389}', 'rocket': '\u{1F680}',
  'thinking': '\u{1F914}', 'eyes': '\u{1F440}', 'skull': '\u{1F480}',
  '100': '\u{1F4AF}', 'poop': '\u{1F4A9}', 'ghost': '\u{1F47B}',
  'shrug': '\u{1F937}', 'facepalm': '\u{1F926}', 'rofl': '\u{1F923}',
  'upside_down': '\u{1F643}', 'rolling_eyes': '\u{1F644}', 'hugging': '\u{1F917}',
  'cowboy': '\u{1F920}', 'clown': '\u{1F921}', 'nerd': '\u{1F913}',
  'money_mouth': '\u{1F911}', 'zipper_mouth': '\u{1F910}', 'nauseated': '\u{1F922}',
  'sneezing': '\u{1F927}', 'dizzy_face': '\u{1F635}', 'exploding_head': '\u{1F92F}',
  'partying_face': '\u{1F973}', 'hot_face': '\u{1F975}', 'cold_face': '\u{1F976}',
  'yawning_face': '\u{1F971}', 'pleading_face': '\u{1F97A}',
  'dog': '\u{1F436}', 'cat': '\u{1F431}', 'mouse': '\u{1F42D}',
  'hamster': '\u{1F439}', 'rabbit': '\u{1F430}', 'fox': '\u{1F98A}',
  'bear': '\u{1F43B}', 'panda': '\u{1F43C}', 'koala': '\u{1F428}',
  'tiger': '\u{1F42F}', 'lion': '\u{1F981}', 'cow': '\u{1F402}',
  'pig': '\u{1F416}', 'frog': '\u{1F438}', 'monkey': '\u{1F435}',
  'chicken': '\u{1F414}', 'penguin': '\u{1F427}', 'bird': '\u{1F426}',
  'eagle': '\u{1F985}', 'owl': '\u{1F989}', 'duck': '\u{1F986}',
  'fish': '\u{1F41F}', 'shark': '\u{1F988}', 'octopus': '\u{1F419}',
  'butterfly': '\u{1F98B}', 'snail': '\u{1F40C}', 'bug': '\u{1F41B}',
  'ant': '\u{1F41C}', 'bee': '\u{1F41D}', 'ladybug': '\u{1F41E}',
  'apple': '\u{1F34E}', 'orange': '\u{1F34A}', 'lemon': '\u{1F34B}',
  'banana': '\u{1F34C}', 'watermelon': '\u{1F349}', 'grapes': '\u{1F347}',
  'strawberry': '\u{1F353}', 'cherry': '\u{1F352}', 'peach': '\u{1F351}',
  'pineapple': '\u{1F34D}', 'coconut': '\u{1F965}', 'avocado': '\u{1F951}',
  'coffee': '\u{2615}', 'tea': '\u{1F375}', 'beer': '\u{1F37A}',
  'wine': '\u{1F347}', 'cocktail': '\u{1F378}', 'pizza': '\u{1F355}',
  'burger': '\u{1F354}', 'fries': '\u{1F35F}', 'taco': '\u{1F32E}',
  'sushi': '\u{1F363}', 'ramen': '\u{1F35C}', 'cake': '\u{1F370}',
  'cookie': '\u{1F36A}', 'candy': '\u{1F36C}', 'chocolate': '\u{1F36B}',
  'soccer': '\u{26BD}', 'basketball': '\u{1F3C0}', 'football': '\u{1F3C8}',
  'baseball': '\u{26BE}', 'tennis': '\u{1F3BE}', 'volleyball': '\u{1F3D0}',
  'guitar': '\u{1F3B8}', 'piano': '\u{1F3B9}', 'drum': '\u{1F941}',
  'trophy': '\u{1F3C6}', 'medal': '\u{1F3C5}', 'crown': '\u{1F451}',
  'gift': '\u{1F381}', 'bell': '\u{1F514}', 'no_bell': '\u{1F515}',
  'key': '\u{1F511}', 'lock': '\u{1F512}', 'unlock': '\u{1F513}',
  'hammer': '\u{1F528}', 'wrench': '\u{1F527}', 'gear': '\u{2699}',
  'mag': '\u{1F50D}', 'bulb': '\u{1F4A1}', 'flashlight': '\u{1F526}',
  'book': '\u{1F4D6}', 'books': '\u{1F4DA}', 'notebook': '\u{1F4D3}',
  'pencil': '\u{270F}', 'pen': '\u{1F58A}', 'memo': '\u{1F4DD}',
  'calendar': '\u{1F4C5}', 'clock': '\u{1F570}', 'alarm': '\u{23F0}',
  'watch': '\u{231A}', 'hourglass': '\u{231B}', 'timer': '\u{23F2}',
  'sun': '\u{2600}', 'moon': '\u{1F319}', 'star2': '\u{1F31F}',
  'cloud': '\u{2601}', 'rainbow': '\u{1F308}', 'snowflake': '\u{2744}',
  'lightning': '\u{26A1}', 'tornado': '\u{1F32A}', 'fire2': '\u{1F525}',
  'earth': '\u{1F30D}', 'globe': '\u{1F310}', 'compass': '\u{1F9ED}',
  'mountain': '\u{1F3D4}', 'beach': '\u{1F3D6}', 'desert': '\u{1F3DC}',
  'house': '\u{1F3E0}', 'school': '\u{1F3EB}', 'bank': '\u{1F3E6}',
  'hospital': '\u{1F3E5}', 'church': '\u{26EA}', 'factory': '\u{1F3ED}',
  'car': '\u{1F697}', 'taxi': '\u{1F695}', 'bus': '\u{1F68C}',
  'train': '\u{1F684}', 'plane': '\u{2708}', 'ship': '\u{1F6A2}',
  'bike': '\u{1F6B2}', 'rocket2': '\u{1F680}', 'ufo': '\u{1F6F8}',
  'phone': '\u{1F4F1}', 'computer': '\u{1F4BB}', 'keyboard': '\u{2328}',
  'mouse2': '\u{1F5B1}', 'printer': '\u{1F5B6}', 'tv': '\u{1F4FA}',
  'radio': '\u{1F4FB}', 'camera': '\u{1F4F7}', 'video': '\u{1F4F9}',
  'mailbox': '\u{1F4EB}', 'package': '\u{1F4E6}', 'inbox': '\u{1F4E5}',
  'envelope': '\u{2709}', 'love_letter': '\u{1F48C}', 'bomb': '\u{1F4A3}',
  'knife': '\u{1F52A}', 'gun': '\u{1F52B}', 'pill': '\u{1F48A}',
  'syringe': '\u{1F489}', 'money': '\u{1F4B0}', 'dollar': '\u{1F4B5}',
  'credit_card': '\u{1F4B3}', 'gem': '\u{1F48E}', 'ring': '\u{1F48D}',
  'check': '\u{2713}', 'cross': '\u{274C}', 'warning': '\u{26A0}',
  'question': '\u{2753}', 'exclamation': '\u{2757}', 'info': '\u{2139}',
  'arrow_up': '\u{2B06}', 'arrow_down': '\u{2B07}', 'arrow_left': '\u{2B05}',
  'arrow_right': '\u{27A1}', 'up': '\u{1F199}', 'down': '\u{1F19D}',
  'back': '\u{1F519}', 'next': '\u{1F51A}', 'top': '\u{1F51D}',
  'bottom': '\u{1F51C}', 'repeat': '\u{1F501}', 'shuffle': '\u{1F500}',
  'zero': '0\u{FE0F}\u{20E3}', 'one': '1\u{FE0F}\u{20E3}', 'two': '2\u{FE0F}\u{20E3}',
  'three': '3\u{FE0F}\u{20E3}', 'four': '4\u{FE0F}\u{20E3}', 'five': '5\u{FE0F}\u{20E3}',
  'six': '6\u{FE0F}\u{20E3}', 'seven': '7\u{FE0F}\u{20E3}', 'eight': '8\u{FE0F}\u{20E3}',
  'nine': '9\u{FE0F}\u{20E3}', 'ten': '\u{1F51F}',
};

/** Replace :emoji_name: codes with native Unicode emoji */
export function replaceColons(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (match, name) => {
    return EMOJI_MAP[name] || match;
  });
}

/** Search emoji by name prefix */
export function searchEmoji(query: string): { name: string; emoji: string }[] {
  const lower = query.toLowerCase();
  return Object.entries(EMOJI_MAP)
    .filter(([name]) => name.includes(lower))
    .slice(0, 50)
    .map(([name, emoji]) => ({ name, emoji }));
}

/** Get all emoji for the picker */
export function getAllEmoji(): { name: string; emoji: string }[] {
  return Object.entries(EMOJI_MAP).map(([name, emoji]) => ({ name, emoji }));
}
