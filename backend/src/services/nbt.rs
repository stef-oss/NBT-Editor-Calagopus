use flate2::{
    Compression,
    read::{GzDecoder, ZlibDecoder},
    write::{GzEncoder, ZlibEncoder},
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

const MAX_DEPTH: usize = 128;
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NbtEdition {
    Java,
    Bedrock,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NbtCompression {
    None,
    Gzip,
    Zlib,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNbt {
    pub edition: NbtEdition,
    pub compression: NbtCompression,
    pub root_name: String,
    pub root: NbtNode,
    pub bedrock_header_version: Option<u32>,
    pub rootless: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NbtNode {
    pub tag_type: String,
    pub value: NbtValue,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum NbtValue {
    Byte { value: i8 },
    Short { value: i16 },
    Int { value: i32 },
    Long { value: i64 },
    Float { value: f32 },
    Double { value: f64 },
    String { value: String },
    ByteArray { length: usize, preview: Vec<i8> },
    IntArray { length: usize, preview: Vec<i32> },
    LongArray { length: usize, preview: Vec<i64> },
    List {
        #[serde(rename = "elementType", alias = "element_type")]
        element_type: String,
        length: usize,
        items: Vec<NbtNode>,
    },
    Compound { entries: Vec<NbtEntry> },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NbtEntry {
    pub name: String,
    pub node: NbtNode,
}

#[derive(Clone, Copy)]
enum Endian {
    Big,
    Little,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    endian: Endian,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], endian: Endian) -> Self {
        Self { bytes, offset: 0, endian }
    }

    fn read_exact(&mut self, length: usize) -> Result<&'a [u8], anyhow::Error> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| anyhow::anyhow!("invalid NBT offset"))?;
        if end > self.bytes.len() {
            return Err(anyhow::anyhow!("unexpected end of NBT data"));
        }

        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn read_u8(&mut self) -> Result<u8, anyhow::Error> {
        Ok(self.read_exact(1)?[0])
    }

    fn read_i8(&mut self) -> Result<i8, anyhow::Error> {
        Ok(self.read_u8()? as i8)
    }

    fn read_i16(&mut self) -> Result<i16, anyhow::Error> {
        let bytes: [u8; 2] = self.read_exact(2)?.try_into()?;
        Ok(match self.endian {
            Endian::Big => i16::from_be_bytes(bytes),
            Endian::Little => i16::from_le_bytes(bytes),
        })
    }

    fn read_u16(&mut self) -> Result<u16, anyhow::Error> {
        let bytes: [u8; 2] = self.read_exact(2)?.try_into()?;
        Ok(match self.endian {
            Endian::Big => u16::from_be_bytes(bytes),
            Endian::Little => u16::from_le_bytes(bytes),
        })
    }

    fn read_i32(&mut self) -> Result<i32, anyhow::Error> {
        let bytes: [u8; 4] = self.read_exact(4)?.try_into()?;
        Ok(match self.endian {
            Endian::Big => i32::from_be_bytes(bytes),
            Endian::Little => i32::from_le_bytes(bytes),
        })
    }

    fn read_i64(&mut self) -> Result<i64, anyhow::Error> {
        let bytes: [u8; 8] = self.read_exact(8)?.try_into()?;
        Ok(match self.endian {
            Endian::Big => i64::from_be_bytes(bytes),
            Endian::Little => i64::from_le_bytes(bytes),
        })
    }

    fn read_f32(&mut self) -> Result<f32, anyhow::Error> {
        let bytes: [u8; 4] = self.read_exact(4)?.try_into()?;
        Ok(match self.endian {
            Endian::Big => f32::from_be_bytes(bytes),
            Endian::Little => f32::from_le_bytes(bytes),
        })
    }

    fn read_f64(&mut self) -> Result<f64, anyhow::Error> {
        let bytes: [u8; 8] = self.read_exact(8)?.try_into()?;
        Ok(match self.endian {
            Endian::Big => f64::from_be_bytes(bytes),
            Endian::Little => f64::from_le_bytes(bytes),
        })
    }

    fn read_string(&mut self) -> Result<String, anyhow::Error> {
        let length = self.read_u16()? as usize;
        Ok(String::from_utf8_lossy(self.read_exact(length)?).to_string())
    }

    fn is_done(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn tag_name(tag_type: u8) -> &'static str {
    match tag_type {
        0 => "end",
        1 => "byte",
        2 => "short",
        3 => "int",
        4 => "long",
        5 => "float",
        6 => "double",
        7 => "byteArray",
        8 => "string",
        9 => "list",
        10 => "compound",
        11 => "intArray",
        12 => "longArray",
        _ => "unknown",
    }
}

fn read_len(reader: &mut Reader<'_>) -> Result<usize, anyhow::Error> {
    let length = reader.read_i32()?;
    if length < 0 {
        return Err(anyhow::anyhow!("negative NBT length"));
    }
    Ok(length as usize)
}

fn read_node(reader: &mut Reader<'_>, tag_type: u8, depth: usize) -> Result<NbtNode, anyhow::Error> {
    if depth > MAX_DEPTH {
        return Err(anyhow::anyhow!("NBT tree is too deep"));
    }

    let value = match tag_type {
        1 => NbtValue::Byte { value: reader.read_i8()? },
        2 => NbtValue::Short { value: reader.read_i16()? },
        3 => NbtValue::Int { value: reader.read_i32()? },
        4 => NbtValue::Long { value: reader.read_i64()? },
        5 => NbtValue::Float { value: reader.read_f32()? },
        6 => NbtValue::Double { value: reader.read_f64()? },
        7 => {
            let length = read_len(reader)?;
            let mut preview = Vec::with_capacity(length);
            for _ in 0..length {
                let value = reader.read_i8()?;
                preview.push(value);
            }
            NbtValue::ByteArray { length, preview }
        }
        8 => NbtValue::String { value: reader.read_string()? },
        9 => {
            let element_type = reader.read_u8()?;
            let length = read_len(reader)?;
            let mut items = Vec::with_capacity(length);
            for _ in 0..length {
                let item = read_node(reader, element_type, depth + 1)?;
                items.push(item);
            }
            NbtValue::List {
                element_type: tag_name(element_type).to_string(),
                length,
                items,
            }
        }
        10 => {
            let mut entries = Vec::new();
            loop {
                let child_type = reader.read_u8()?;
                if child_type == 0 {
                    break;
                }
                if child_type > 12 {
                    return Err(anyhow::anyhow!("unknown NBT tag type {child_type}"));
                }
                let name = reader.read_string()?;
                let node = read_node(reader, child_type, depth + 1)?;
                entries.push(NbtEntry { name, node });
            }
            NbtValue::Compound { entries }
        }
        11 => {
            let length = read_len(reader)?;
            let mut preview = Vec::with_capacity(length);
            for _ in 0..length {
                let value = reader.read_i32()?;
                preview.push(value);
            }
            NbtValue::IntArray { length, preview }
        }
        12 => {
            let length = read_len(reader)?;
            let mut preview = Vec::with_capacity(length);
            for _ in 0..length {
                let value = reader.read_i64()?;
                preview.push(value);
            }
            NbtValue::LongArray { length, preview }
        }
        _ => return Err(anyhow::anyhow!("unknown NBT tag type {tag_type}")),
    };

    Ok(NbtNode { tag_type: tag_name(tag_type).to_string(), value })
}

fn decompress(bytes: &[u8]) -> Result<(Vec<u8>, NbtCompression), anyhow::Error> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(bytes);
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded)?;
        return Ok((decoded, NbtCompression::Gzip));
    }

    if bytes.first().copied() == Some(0x78) {
        let mut decoder = ZlibDecoder::new(bytes);
        let mut decoded = Vec::new();
        if decoder.read_to_end(&mut decoded).is_ok() {
            return Ok((decoded, NbtCompression::Zlib));
        }
    }

    Ok((bytes.to_vec(), NbtCompression::None))
}

fn parse_named_root(bytes: &[u8], endian: Endian, edition: NbtEdition, compression: NbtCompression) -> Result<ParsedNbt, anyhow::Error> {
    let mut reader = Reader::new(bytes, endian);
    let root_type = reader.read_u8()?;
    if root_type != 10 {
        return Err(anyhow::anyhow!("root NBT tag is not a compound"));
    }

    let root_name = reader.read_string()?;
    let root = read_node(&mut reader, root_type, 0)?;
    if !reader.is_done() {
        return Err(anyhow::anyhow!("NBT data has trailing bytes"));
    }
    Ok(ParsedNbt { edition, compression, root_name, root, bedrock_header_version: None, rootless: false })
}

fn parse_rootless_compound(
    bytes: &[u8],
    endian: Endian,
    edition: NbtEdition,
    compression: NbtCompression,
    bedrock_header_version: Option<u32>,
) -> Result<ParsedNbt, anyhow::Error> {
    let mut reader = Reader::new(bytes, endian);
    let root = read_node(&mut reader, 10, 0)?;
    if !reader.is_done() {
        return Err(anyhow::anyhow!("NBT data has trailing bytes"));
    }
    Ok(ParsedNbt {
        edition,
        compression,
        root_name: "level.dat".to_string(),
        root,
        bedrock_header_version,
        rootless: true,
    })
}

fn looks_like_bedrock_level_dat(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }

    let version = u32::from_le_bytes(match bytes[0..4].try_into() {
        Ok(bytes) => bytes,
        Err(_) => return false,
    });
    if !(1..=100).contains(&version) {
        return false;
    }

    let length = u32::from_le_bytes(match bytes[4..8].try_into() {
        Ok(bytes) => bytes,
        Err(_) => return false,
    }) as usize;

    length > 0 && length <= bytes.len().saturating_sub(8)
}

fn parse_bedrock_level_dat(bytes: &[u8], compression: NbtCompression) -> Result<ParsedNbt, anyhow::Error> {
    if bytes.len() < 8 {
        return Err(anyhow::anyhow!("missing Bedrock level.dat header"));
    }

    let version = u32::from_le_bytes(bytes[0..4].try_into()?);
    if !(1..=100).contains(&version) {
        return Err(anyhow::anyhow!("invalid Bedrock level.dat version"));
    }

    let length = u32::from_le_bytes(bytes[4..8].try_into()?) as usize;
    if length > bytes.len().saturating_sub(8) {
        return Err(anyhow::anyhow!("invalid Bedrock level.dat length"));
    }

    let payload = &bytes[8..8 + length];
    parse_named_root(payload, Endian::Little, NbtEdition::Bedrock, compression)
        .map(|mut parsed| {
            parsed.bedrock_header_version = Some(version);
            parsed
        })
        .or_else(|_| parse_rootless_compound(payload, Endian::Little, NbtEdition::Bedrock, compression, Some(version)))
}

pub fn parse_nbt(bytes: &[u8], requested: Option<NbtEdition>) -> Result<ParsedNbt, anyhow::Error> {
    let (decoded, compression) = decompress(bytes)?;

    match requested {
        Some(NbtEdition::Java) => parse_named_root(&decoded, Endian::Big, NbtEdition::Java, compression),
        Some(NbtEdition::Bedrock) => parse_bedrock_level_dat(&decoded, compression)
            .or_else(|_| parse_named_root(&decoded, Endian::Little, NbtEdition::Bedrock, compression)),
        None if looks_like_bedrock_level_dat(&decoded) => parse_bedrock_level_dat(&decoded, compression)
            .or_else(|_| parse_named_root(&decoded, Endian::Big, NbtEdition::Java, compression))
            .or_else(|_| parse_named_root(&decoded, Endian::Little, NbtEdition::Bedrock, compression)),
        None => parse_named_root(&decoded, Endian::Big, NbtEdition::Java, compression)
            .or_else(|_| parse_named_root(&decoded, Endian::Little, NbtEdition::Bedrock, compression))
            .or_else(|_| parse_bedrock_level_dat(&decoded, compression)),
    }
}

fn tag_id(tag_type: &str) -> Result<u8, anyhow::Error> {
    match tag_type {
        "end" => Ok(0),
        "byte" => Ok(1),
        "short" => Ok(2),
        "int" => Ok(3),
        "long" => Ok(4),
        "float" => Ok(5),
        "double" => Ok(6),
        "byteArray" => Ok(7),
        "string" => Ok(8),
        "list" => Ok(9),
        "compound" => Ok(10),
        "intArray" => Ok(11),
        "longArray" => Ok(12),
        _ => Err(anyhow::anyhow!("unknown NBT tag type {tag_type}")),
    }
}

fn write_i16(output: &mut Vec<u8>, value: i16, endian: Endian) {
    let bytes = match endian {
        Endian::Big => value.to_be_bytes(),
        Endian::Little => value.to_le_bytes(),
    };
    output.extend_from_slice(&bytes);
}

fn write_u16(output: &mut Vec<u8>, value: u16, endian: Endian) {
    let bytes = match endian {
        Endian::Big => value.to_be_bytes(),
        Endian::Little => value.to_le_bytes(),
    };
    output.extend_from_slice(&bytes);
}

fn write_i32(output: &mut Vec<u8>, value: i32, endian: Endian) {
    let bytes = match endian {
        Endian::Big => value.to_be_bytes(),
        Endian::Little => value.to_le_bytes(),
    };
    output.extend_from_slice(&bytes);
}

fn write_i64(output: &mut Vec<u8>, value: i64, endian: Endian) {
    let bytes = match endian {
        Endian::Big => value.to_be_bytes(),
        Endian::Little => value.to_le_bytes(),
    };
    output.extend_from_slice(&bytes);
}

fn write_f32(output: &mut Vec<u8>, value: f32, endian: Endian) {
    let bytes = match endian {
        Endian::Big => value.to_be_bytes(),
        Endian::Little => value.to_le_bytes(),
    };
    output.extend_from_slice(&bytes);
}

fn write_f64(output: &mut Vec<u8>, value: f64, endian: Endian) {
    let bytes = match endian {
        Endian::Big => value.to_be_bytes(),
        Endian::Little => value.to_le_bytes(),
    };
    output.extend_from_slice(&bytes);
}

fn write_string(output: &mut Vec<u8>, value: &str, endian: Endian) -> Result<(), anyhow::Error> {
    if value.len() > u16::MAX as usize {
        return Err(anyhow::anyhow!("NBT string is too long"));
    }
    write_u16(output, value.len() as u16, endian);
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn write_node_payload(output: &mut Vec<u8>, node: &NbtNode, endian: Endian) -> Result<(), anyhow::Error> {
    match &node.value {
        NbtValue::Byte { value } => output.push(*value as u8),
        NbtValue::Short { value } => write_i16(output, *value, endian),
        NbtValue::Int { value } => write_i32(output, *value, endian),
        NbtValue::Long { value } => write_i64(output, *value, endian),
        NbtValue::Float { value } => write_f32(output, *value, endian),
        NbtValue::Double { value } => write_f64(output, *value, endian),
        NbtValue::String { value } => write_string(output, value, endian)?,
        NbtValue::ByteArray { preview, .. } => {
            write_i32(output, preview.len() as i32, endian);
            output.extend(preview.iter().map(|value| *value as u8));
        }
        NbtValue::IntArray { preview, .. } => {
            write_i32(output, preview.len() as i32, endian);
            for value in preview {
                write_i32(output, *value, endian);
            }
        }
        NbtValue::LongArray { preview, .. } => {
            write_i32(output, preview.len() as i32, endian);
            for value in preview {
                write_i64(output, *value, endian);
            }
        }
        NbtValue::List { element_type, items, .. } => {
            let element_id = if items.is_empty() { tag_id(element_type)? } else { tag_id(&items[0].tag_type)? };
            output.push(element_id);
            write_i32(output, items.len() as i32, endian);
            for item in items {
                write_node_payload(output, item, endian)?;
            }
        }
        NbtValue::Compound { entries } => {
            for entry in entries {
                let tag = tag_id(&entry.node.tag_type)?;
                output.push(tag);
                write_string(output, &entry.name, endian)?;
                write_node_payload(output, &entry.node, endian)?;
            }
            output.push(0);
        }
    }
    Ok(())
}

fn encode_payload(parsed: &ParsedNbt, endian: Endian) -> Result<Vec<u8>, anyhow::Error> {
    if parsed.root.tag_type != "compound" {
        return Err(anyhow::anyhow!("root NBT tag must be a compound"));
    }

    let mut output = Vec::new();
    if !parsed.rootless {
        output.push(10);
        write_string(&mut output, &parsed.root_name, endian)?;
    }
    write_node_payload(&mut output, &parsed.root, endian)?;
    Ok(output)
}

fn compress(bytes: Vec<u8>, compression: NbtCompression) -> Result<Vec<u8>, anyhow::Error> {
    match compression {
        NbtCompression::None => Ok(bytes),
        NbtCompression::Gzip => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&bytes)?;
            Ok(encoder.finish()?)
        }
        NbtCompression::Zlib => {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(&bytes)?;
            Ok(encoder.finish()?)
        }
    }
}

pub fn encode_nbt(parsed: &ParsedNbt) -> Result<Vec<u8>, anyhow::Error> {
    let payload = match parsed.edition {
        NbtEdition::Java => encode_payload(parsed, Endian::Big)?,
        NbtEdition::Bedrock => {
            let payload = encode_payload(parsed, Endian::Little)?;
            if let Some(version) = parsed.bedrock_header_version {
                let mut output = Vec::with_capacity(payload.len() + 8);
                output.extend_from_slice(&version.to_le_bytes());
                output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
                output.extend_from_slice(&payload);
                output
            } else {
                payload
            }
        }
    };

    compress(payload, parsed.compression)
}
