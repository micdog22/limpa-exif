# Limpa EXIF — remova a localização e outros metadados das suas fotos (HTML + JavaScript)

Fotos tiradas no celular costumam carregar as coordenadas de GPS de onde foram feitas, o modelo do aparelho, a data e a hora, o programa usado e às vezes até o nome do dono e o número de série da câmera. Quem vende algo em site de anúncios, manda foto por e-mail ou compartilha o arquivo original pode estar contando, sem querer, onde mora.

O Limpa EXIF mostra o que cada foto revela e gera uma cópia limpa, sem recomprimir a imagem. Tudo roda no navegador: as fotos não saem do seu aparelho.

**Acesse online:** https://micdog22.github.io/limpa-exif/

## Recursos

- Arraste ou escolha várias fotos JPEG e PNG de uma vez.
- Aviso claro quando a foto tem GPS ("esta foto revela onde foi tirada"), com as coordenadas e um link para conferir o local no OpenStreetMap (o link só abre se você clicar).
- Mostra câmera, lente, data e hora, programa, orientação, autor, dono da câmera, número de série, comentários e a presença de XMP, IPTC e miniatura embutida.
- JPEG limpo **sem perda de qualidade**: os blocos de metadados são retirados e os dados da imagem ficam byte a byte iguais.
- Mantém a orientação: se a foto estava marcada como girada, a cópia ganha um Exif mínimo só com esse dado, para não aparecer deitada.
- Download individual ou de todas as fotos em um `.zip`.
- Sem dependências, sem servidor, sem rastreadores.

## Como usar

1. Abra a página e arraste as fotos (ou toque em **Escolher fotos**).
2. Confira o que foi encontrado em cada foto. Fotos com localização aparecem com um aviso em destaque.
3. Baixe a cópia limpa de cada uma ou use **Baixar todas (.zip)**.

As cópias recebem o sufixo `-limpa` no nome (`praia.jpg` → `praia-limpa.jpg`).

## Como rodar localmente

Módulos ES não carregam via `file://`, então sirva a pasta com qualquer servidor estático:

```bash
python3 -m http.server 8000
```

Depois abra http://localhost:8000.

## Testes

```bash
npm test
```

Os testes (com `node:test`, sem dependências) montam arquivos sintéticos na hora: JPEGs com Exif nas duas ordens de bytes (II e MM), GPS, orientação, XMP, IPTC e comentários; PNGs com blocos de texto, eXIf e tIME; além do CRC-32 e da estrutura do ZIP.

## Como funciona

**JPEG.** O arquivo é percorrido segmento por segmento, sem decodificar a imagem:

| Segmento | O que acontece |
| --- | --- |
| APP0 (JFIF) | mantido |
| APP1 (Exif, XMP) | removido |
| APP2 `ICC_PROFILE` (perfil de cor) | mantido |
| APP2 de outros tipos (FPXR, MPF…) | removido |
| APP13 (IPTC/Photoshop) | removido |
| APP14 (Adobe) | mantido |
| Outros APPn e COM (comentário) | removidos |
| DQT, DHT, SOF, DRI, SOS e dados da imagem | mantidos sem alteração |
| Bytes depois do marcador de fim (EOI) | removidos |

Se a tag Orientation (0x0112 no IFD0) era diferente de 1, um APP1 novo e mínimo é gravado logo depois do APP0: `Exif\0\0` + cabeçalho TIFF + um IFD0 só com Orientation (SHORT). São 36 bytes.

**PNG.** Saem os blocos `tEXt`, `zTXt`, `iTXt`, `eXIf` e `tIME` (e blocos auxiliares desconhecidos). Ficam os blocos críticos e os que afetam a exibição: `iCCP`, `sRGB`, `gAMA`, `cHRM`, `pHYs`, `tRNS`, `bKGD`, os de animação (APNG) e outros. Os blocos mantidos são copiados inteiros, então os CRCs continuam válidos.

**Leitura do Exif.** Um leitor mínimo de TIFF (ordens II e MM) percorre o IFD0, o IFD Exif, o IFD de GPS e o IFD1 (miniatura). As coordenadas em graus, minutos e segundos viram graus decimais, com sinal negativo para S e W. Coordenadas gravadas só no XMP também são detectadas.

**ZIP.** O `.zip` é montado no próprio navegador, sem compressão (fotos já são comprimidas), com CRC-32 e nomes em UTF-8.

## Limitações

- Formatos HEIC, WebP, TIFF e RAW não são suportados.
- A ferramenta não altera o conteúdo da imagem: rostos, placas, fachadas e documentos que aparecem na foto continuam visíveis.
- Ela remove os metadados conhecidos, mas não substitui um cuidado extra em casos sensíveis.

## Contribuindo

Issues e pull requests são bem-vindos.

## Licença

MIT — veja [LICENSE](LICENSE).
