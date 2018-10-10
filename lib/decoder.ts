/**
 * @author shaozilee
 *
 * Bmp format decoder,support 1bit 4bit 8bit 24bit bmp
 *
 */

interface IPixel {
  red: number;
  green: number;
  blue: number;
  quad: number;
}

type IPixelProcessor = (x: number, line: number) => void;

const BITMAP_INFO_HEADER = 40;
const BITMAP_V2_INFO_HEADER = 52;
const BITMAP_V3_INFO_HEADER = 56;
const BITMAP_V4_HEADER = 108;
const BITMAP_V5_HEADER = 124;

const VALID_TYPES = [
  BITMAP_INFO_HEADER,
  BITMAP_V2_INFO_HEADER,
  BITMAP_V3_INFO_HEADER,
  BITMAP_V4_HEADER,
  BITMAP_V5_HEADER
];

const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

class BmpDecoder {
  // Header
  public fileSize!: number;
  public reserved1!: number;
  public reserved2!: number;
  public offset!: number;
  public headerSize!: number;
  public width!: number;
  public height!: number;
  public planes!: number;
  public bitPP!: number;
  public compression!: number;
  public rawSize!: number;
  public hr!: number;
  public vr!: number;
  public colors!: number;
  public importantColors!: number;
  public palette!: IPixel[];

  public maskRed!: number;
  public maskGreen!: number;
  public maskBlue!: number;
  public maskAlpha!: number;

  public toRGBA: boolean;

  private data!: Buffer;
  private pos: number;
  private buffer: Buffer;
  private bottomUp: boolean;
  private flag: string;

  private locRed: number;
  private locGreen: number;
  private locBlue: number;
  private locAlpha: number;

  private shiftRed!: (x: number) => number;
  private shiftGreen!: (x: number) => number;
  private shiftBlue!: (x: number) => number;
  private shiftAlpha!: (x: number) => number;

  constructor(buffer: Buffer, toRGBA = false) {
    this.buffer = buffer;

    this.toRGBA = !!toRGBA;
    this.pos = 0;
    this.bottomUp = true;
    this.flag = this.buffer.toString('utf-8', 0, (this.pos += 2));

    if (this.flag != 'BM') {
      throw new Error('Invalid BMP File');
    }

    this.locRed = this.toRGBA ? 0 : 3;
    this.locGreen = this.toRGBA ? 1 : 2;
    this.locBlue = this.toRGBA ? 2 : 1;
    this.locAlpha = this.toRGBA ? 3 : 0;

    this.parseHeader();
    this.parseRGBA();
  }

  public parseHeader() {
    this.fileSize = this.readUInt32LE();
    this.reserved1 = this.buffer.readUInt16LE(this.pos);
    this.pos += 2;
    this.reserved2 = this.buffer.readUInt16LE(this.pos);
    this.pos += 2;
    this.offset = this.readUInt32LE();

    // End of BITMAPFILEHEADER

    if (VALID_TYPES.indexOf(this.headerSize) === -1) {
      throw new Error('Unsupported BMP header size ' + this.headerSize);
    }

    this.headerSize = this.readUInt32LE();
    this.width = this.readUInt32LE();
    this.height = this.buffer.readInt32LE(this.pos);
    this.pos += 4;
    this.planes = this.buffer.readUInt16LE(this.pos);
    this.pos += 2;
    this.bitPP = this.buffer.readUInt16LE(this.pos);
    this.pos += 2;
    this.compression = this.readUInt32LE();
    this.rawSize = this.readUInt32LE();
    this.hr = this.readUInt32LE();
    this.vr = this.readUInt32LE();
    this.colors = this.readUInt32LE();
    this.importantColors = this.readUInt32LE();

    // De facto defaults

    if (this.bitPP === 32) {
      this.maskAlpha = 0;
      this.maskRed = 0x00ff0000;
      this.maskGreen = 0x0000ff00;
      this.maskBlue = 0x000000ff;
    } else if (this.bitPP === 16) {
      this.maskAlpha = 0;
      this.maskRed = 0x7c00;
      this.maskGreen = 0x03e0;
      this.maskBlue = 0x001f;
    }

    // End of BITMAP_INFO_HEADER

    if (
      this.headerSize > BITMAP_INFO_HEADER ||
      this.compression === BI_BITFIELDS ||
      this.compression === BI_ALPHABITFIELDS
    ) {
      this.maskRed = this.readUInt32LE();
      this.maskGreen = this.readUInt32LE();
      this.maskBlue = this.readUInt32LE();
    }

    // End of BITMAP_V2_INFO_HEADER

    if (
      this.headerSize > BITMAP_V2_INFO_HEADER ||
      this.compression === BI_ALPHABITFIELDS
    ) {
      this.maskAlpha = this.readUInt32LE();
    }

    // End of BITMAP_V3_INFO_HEADER

    if (this.headerSize > BITMAP_V3_INFO_HEADER) {
      this.pos += BITMAP_V4_HEADER - BITMAP_V3_INFO_HEADER;
    }

    // End of BITMAP_V4_HEADER

    if (this.headerSize > BITMAP_V4_HEADER) {
      this.pos += BITMAP_V5_HEADER - BITMAP_V4_HEADER;
    }

    // End of BITMAP_V5_HEADER

    if (this.bitPP <= 8 || this.colors > 0) {
      const len = this.colors === 0 ? 1 << this.bitPP : this.colors;
      this.palette = new Array(len);

      for (let i = 0; i < len; i++) {
        const blue = this.buffer.readUInt8(this.pos++);
        const green = this.buffer.readUInt8(this.pos++);
        const red = this.buffer.readUInt8(this.pos++);
        const quad = this.buffer.readUInt8(this.pos++);

        this.palette[i] = {
          red: red,
          green: green,
          blue: blue,
          quad: quad
        };
      }
    }

    // End of color table

    if (this.height < 0) {
      this.height *= -1;
      this.bottomUp = false;
    }

    // We have these:
    //
    // const sample = 0101 0101 0101 0101
    // const mask   = 0111 1100 0000 0000
    // 256        === 0000 0001 0000 0000
    //
    // We want to take the sample and turn it into an 8-bit value.
    //
    // 1. We extract the last bit of the mask:
    //
    // 0000 0100 0000 0000
    //       ^
    //
    // Like so:
    //
    // const a = ~mask =    1000 0011 1111 1111
    // const b = a + 1 =    1000 0100 0000 0000
    // const c = b & mask = 0000 0100 0000 0000
    //
    // 2. We shift it to the right and extract the bit before the first:
    //
    // 0000 0000 0010 0000
    //             ^
    //
    // Like so:
    //
    // const d = mask / c = 0000 0000 0001 1111
    // const e = mask + 1 = 0000 0000 0010 0000
    //
    // 3. We apply the mask and the two values above to a sample:
    //
    // const f = sample & mask = 0101 0100 0000 0000
    // const g = f / c =         0000 0000 0001 0101
    // const h = 256 / e =       0000 0000 0000 0100
    // const i = g * h =         0000 0000 1010 1000
    //                                     ^^^^ ^
    //
    // Voila, we have extracted a sample and "stretched" it to 8 bits. For samples
    // which are already 8-bit, h === 1 and g === i.
    const maskRedR = (~this.maskRed + 1) & this.maskRed;
    const maskGreenR = (~this.maskGreen + 1) & this.maskGreen;
    const maskBlueR = (~this.maskBlue + 1) & this.maskBlue;
    const maskAlphaR = (~this.maskAlpha + 1) & this.maskAlpha;
    const shiftedMaskRedL = this.maskRed / maskRedR + 1;
    const shiftedMaskGreenL = this.maskGreen / maskGreenR + 1;
    const shiftedMaskBlueL = this.maskBlue / maskBlueR + 1;
    const shiftedMaskAlphaL = this.maskAlpha / maskAlphaR + 1;

    this.shiftRed = (x: number) =>
      (((x & this.maskRed) / maskRedR) * 0x100) / shiftedMaskRedL;
    this.shiftGreen = (x: number) =>
      (((x & this.maskGreen) / maskGreenR) * 0x100) / shiftedMaskGreenL;
    this.shiftBlue = (x: number) =>
      (((x & this.maskBlue) / maskBlueR) * 0x100) / shiftedMaskBlueL;
    this.shiftAlpha =
      this.maskAlpha !== 0
        ? (x: number) =>
            (((x & this.maskAlpha) / maskAlphaR) * 0x100) / shiftedMaskAlphaL
        : () => 255;
  }

  public parseRGBA() {
    this.data = Buffer.alloc(this.width * this.height * 4);

    switch (this.bitPP) {
      case 1:
        this.bit1();
        break;
      case 4:
        this.bit4();
        break;
      case 8:
        this.bit8();
        break;
      case 16:
        this.bit16();
        break;
      case 24:
        this.bit24();
        break;
      default:
        this.bit32();
    }
  }

  public bit1() {
    const xLen = Math.ceil(this.width / 8);
    const mode = xLen % 4;
    const padding = mode != 0 ? 4 - mode : 0;

    this.scanImage(padding, xLen, (x, line) => {
      const b = this.buffer.readUInt8(this.pos++);
      const location = line * this.width * 4 + x * 8 * 4;

      for (let i = 0; i < 8; i++) {
        if (x * 8 + i < this.width) {
          const rgb = this.palette[(b >> (7 - i)) & 0x1];
          this.data[location + i * 4] = 0;
          this.data[location + i * 4 + 1] = rgb.blue;
          this.data[location + i * 4 + 2] = rgb.green;
          this.data[location + i * 4 + 3] = rgb.red;
        } else {
          break;
        }
      }
    });
  }

  public bit4() {
    if (this.compression == BI_RLE4) {
      this.data.fill(0xff);

      let low_nibble = false; //for all count of pixel
      let lines = this.bottomUp ? this.height - 1 : 0;
      let location = 0;

      while (location < this.data.length) {
        const a = this.buffer.readUInt8(this.pos++);
        const b = this.buffer.readUInt8(this.pos++);

        //absolute mode
        if (a == 0) {
          if (b == 0) {
            //line end
            lines += this.bottomUp ? -1 : 1;
            location = lines * this.width * 4;
            low_nibble = false;

            continue;
          } else if (b == 1) {
            // image end
            break;
          } else if (b == 2) {
            // offset x,y
            const x = this.buffer.readUInt8(this.pos++);
            const y = this.buffer.readUInt8(this.pos++);

            lines += this.bottomUp ? -y : y;
            location += y * this.width * 4 + x * 4;
          } else {
            let c = this.buffer.readUInt8(this.pos++);

            for (let i = 0; i < b; i++) {
              location = this.setPixelData(
                location,
                low_nibble ? c & 0x0f : (c & 0xf0) >> 4
              );

              if (i & 1 && i + 1 < b) {
                c = this.buffer.readUInt8(this.pos++);
              }

              low_nibble = !low_nibble;
            }

            if ((((b + 1) >> 1) & 1) == 1) {
              this.pos++;
            }
          }
        } else {
          //encoded mode
          for (let i = 0; i < a; i++) {
            location = this.setPixelData(
              location,
              low_nibble ? b & 0x0f : (b & 0xf0) >> 4
            );
            low_nibble = !low_nibble;
          }
        }
      }
    } else {
      const xlen = Math.ceil(this.width / 2);
      const mode = xlen % 4;
      const padding = mode != 0 ? 4 - mode : 0;

      this.scanImage(padding, this.width, (x, line) => {
        const b = this.buffer.readUInt8(this.pos++);
        const location = line * this.width * 4 + x * 2 * 4;

        const before = b >> 4;
        const after = b & 0x0f;

        let rgb = this.palette[before];

        this.data[location] = 0;
        this.data[location + 1] = rgb.blue;
        this.data[location + 2] = rgb.green;
        this.data[location + 3] = rgb.red;

        if (x * 2 + 1 >= this.width) {
          // throw new Error('Something');
          return false;
        }

        rgb = this.palette[after];

        this.data[location + 4] = 0;
        this.data[location + 4 + 1] = rgb.blue;
        this.data[location + 4 + 2] = rgb.green;
        this.data[location + 4 + 3] = rgb.red;
      });
    }
  }

  public bit8() {
    if (this.compression == BI_RLE8) {
      this.data.fill(0xff);

      let lines = this.bottomUp ? this.height - 1 : 0;
      let location = 0;

      while (location < this.data.length) {
        const a = this.buffer.readUInt8(this.pos++);
        const b = this.buffer.readUInt8(this.pos++);

        //absolute mode
        if (a == 0) {
          if (b == 0) {
            //line end
            lines += this.bottomUp ? -1 : 1;
            location = lines * this.width * 4;
            continue;
          } else if (b == 1) {
            //image end
            break;
          } else if (b == 2) {
            //offset x,y
            const x = this.buffer.readUInt8(this.pos++);
            const y = this.buffer.readUInt8(this.pos++);

            lines += this.bottomUp ? -y : y;
            location += y * this.width * 4 + x * 4;
          } else {
            for (let i = 0; i < b; i++) {
              const c = this.buffer.readUInt8(this.pos++);
              location = this.setPixelData(location, c);
            }

            // @ts-ignore
            const shouldIncrement = b & (1 == 1);
            if (shouldIncrement) {
              this.pos++;
            }
          }
        } else {
          //encoded mode
          for (let i = 0; i < a; i++) {
            location = this.setPixelData(location, b);
          }
        }
      }
    } else {
      const mode = this.width % 4;
      const padding = mode != 0 ? 4 - mode : 0;

      this.scanImage(padding, this.width, (x, line) => {
        const b = this.buffer.readUInt8(this.pos++);
        const location = line * this.width * 4 + x * 4;

        if (b < this.palette.length) {
          const rgb = this.palette[b];

          this.data[location] = 0;
          this.data[location + 1] = rgb.blue;
          this.data[location + 2] = rgb.green;
          this.data[location + 3] = rgb.red;
        } else {
          this.data[location] = 0;
          this.data[location + 1] = 0xff;
          this.data[location + 2] = 0xff;
          this.data[location + 3] = 0xff;
        }
      });
    }
  }

  public bit16() {
    const padding = (this.width % 2) * 2;

    this.scanImage(padding, this.width, (x, line) => {
      const loc = line * this.width * 4 + x * 4;
      const px = this.buffer.readUInt16LE(this.pos);
      this.pos += 2;

      this.data[loc + this.locRed] = this.shiftRed(px);
      this.data[loc + this.locGreen] = this.shiftGreen(px);
      this.data[loc + this.locBlue] = this.shiftBlue(px);
      this.data[loc + this.locAlpha] = this.shiftAlpha(px);
    });
  }

  public bit24() {
    const padding = this.width % 4;

    this.scanImage(padding, this.width, (x, line) => {
      const loc = line * this.width * 4 + x * 4;
      const blue = this.buffer.readUInt8(this.pos++);
      const green = this.buffer.readUInt8(this.pos++);
      const red = this.buffer.readUInt8(this.pos++);

      this.data[loc + this.locRed] = red;
      this.data[loc + this.locGreen] = green;
      this.data[loc + this.locBlue] = blue;
    });
  }

  public bit32() {
    this.scanImage(0, this.width, (x, line) => {
      const loc = line * this.width * 4 + x * 4;
      const px = this.buffer.readUInt32LE(this.pos);
      this.pos += 4;

      this.data[loc + this.locRed] = this.shiftRed(px);
      this.data[loc + this.locGreen] = this.shiftGreen(px);
      this.data[loc + this.locBlue] = this.shiftBlue(px);
      this.data[loc + this.locAlpha] = this.shiftAlpha(px);
    });
  }

  public getData() {
    return this.data;
  }

  private scanImage(
    padding = 0,
    width = this.width,
    processPixel: IPixelProcessor
  ) {
    for (let y = this.height - 1; y >= 0; y--) {
      const line = this.bottomUp ? y : this.height - 1 - y;

      for (let x = 0; x < width; x++) {
        const result = processPixel.call(this, x, line);

        if (result === false) {
          return;
        }
      }

      this.pos += padding;
    }
  }

  private readUInt32LE() {
    const value = this.buffer.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  private setPixelData(location: number, rgbIndex: number) {
    const rgb = this.palette[rgbIndex];
    this.data[location] = 0;
    this.data[location + 1] = rgb.blue;
    this.data[location + 2] = rgb.green;
    this.data[location + 3] = rgb.red;
    location += 4;

    return location;
  }
}

export default function(bmpData: Buffer) {
  const decoder = new BmpDecoder(bmpData);
  return decoder;
}
