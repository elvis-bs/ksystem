# Pedidos online com Pix

O cardápio digital aceita dinheiro na entrega ou retirada e Pix online pelo Mercado Pago. O pedido pago por Pix só passa de **Aguardando Pix** para **Recebido** após a confirmação do Mercado Pago.

## Pré-requisitos do Mercado Pago

Configure no projeto Supabase os secrets já usados pela integração:

- `MP_CLIENT_ID`
- `MP_CLIENT_SECRET`
- `MP_OAUTH_REDIRECT_URI`: URL da função `mercadopago-oauth-callback` deste projeto Supabase.
- `MP_OAUTH_APP_URL`: URL publicada do Bora! Gestão para onde o cliente volta após autorizar a conta.
- `MP_WEBHOOK_SECRET`: chave secreta de assinatura do webhook de pagamentos configurado no painel da aplicação Mercado Pago.
- `MP_TEST_MODE`: `true` para credenciais de teste; `false` para produção.

Não coloque essas credenciais no código nem no cardápio público. Cadastre a mesma URL de callback nas configurações OAuth da aplicação Mercado Pago e configure o evento de pagamentos para usar a função `mercadopago-webhook`.

## Atualização do banco e funções

1. Execute `supabase-schema.sql` no **SQL Editor** do Supabase, caso ainda não tenha aplicado o esquema de pagamentos.
2. No terminal, autorize e associe a CLI ao projeto:

   ```powershell
   supabase login
   supabase link --project-ref jnqwtqixklmuxaeppkry
   ```

3. Publique as funções:

   ```powershell
   supabase functions deploy create-cash-order
   supabase functions deploy mercadopago-settings
   supabase functions deploy mercadopago-oauth-callback
   supabase functions deploy mercadopago-webhook
   supabase functions deploy check-pix-order
   ```

4. Publique o site no GitHub Pages e entre no Bora! Gestão.
5. Abra **Cardápio digital** e clique em **Conectar conta Mercado Pago**. Autorize a conta que receberá os pagamentos.
6. Publique o cardápio e ative **Aceitar pedidos online**.
7. Em **Configurações**, cadastre os horários semanais e o fuso da loja. Escolha **Usar horário automático** ou abra/feche a loja manualmente. Os horários começam desativados até serem cadastrados.
8. Abra o caixa e aguarde o status **Sincronizado**. Novos pedidos só são aceitos com o caixa aberto, os pedidos online ativados e a loja aberta pelo horário ou manualmente. A escolha manual permanece até trocar o modo.

O cardápio mostra a loja aberta ou fechada e, quando fechada, a próxima abertura prevista pelos horários cadastrados. A previsão não garante que a loja abrirá: se o caixa continuar fechado ou os pedidos estiverem desativados, o cardápio permanece fechado e mostra o próximo horário programado.

Na página **Cardápio digital**, lojas com cardápio publicado podem abrir a **prévia Elvis na Chapa**. Ela usa os produtos e a disponibilidade publicados, mas a finalização é apenas visual: não envia pedidos, não gera Pix e não substitui o cardápio público.

A prévia oferece busca e ordenação dentro da categoria selecionada, favoritos salvos neste navegador por loja, personalização dos produtos disponíveis e uma sacola com etapas de dados e conferência. Nos lanches com ingredientes cadastrados, é possível simular a retirada de ingredientes por item, sem alteração de preço; essa escolha e as observações por produto aparecem na sacola e na conferência, mas não são enviadas à loja. O menu **Personalizar prévia** controla apenas a animação durante a visita; endereço, taxa e funcionamento continuam vindo das configurações publicadas da loja.
As imagens de lanches são ilustrativas, extraídas do HTML de referência; não representam necessariamente os produtos cadastrados.

O nome exibido no visual Elvis (prévia e link real) vem do campo **Nome da loja** em **Configurações**, nos dados para o cupom. Ele é publicado com o cardápio quando as configurações são sincronizadas; sem nome publicado, aparece “Minha loja”. Após atualizar o site, entre no sistema e aguarde **Sincronizado** para atualizar cardápios publicados anteriormente.

O **link real Elvis na Chapa**, disponível separadamente na página **Cardápio digital**, aceita pedidos e pagamentos reais e mantém o link atual e a prévia de teste inalterados. A retirada de ingredientes nos lanches não altera o preço e é validada pelo servidor contra o cardápio publicado; ela aparece no pedido e no cupom. A finalização deste link fica indisponível se a função `create-cash-order` não anunciar suporte à retirada de ingredientes. Publique essa função antes de divulgar o novo link. A disponibilidade e o Pix seguem as mesmas configurações e regras do cardápio atual.

Neste link, o cliente pode escrever uma observação de até 160 caracteres para cada produto adicionado à sacola. Ela vale para todas as unidades da quantidade escolhida e aparece na sacola, conferência, pedido e cupom. Pedidos de ingredientes extras são sujeitos à confirmação da loja e não alteram o preço automaticamente; os adicionais cobrados devem ser selecionados entre os cadastrados. A observação geral do pedido continua disponível. A função `create-cash-order` deve ser publicada antes do site para habilitar as observações por produto.

## Fotos dos lanches

Antes de publicar o site com envio de fotos, execute [product-photos.sql](./product-photos.sql) no SQL Editor do Supabase. Ele cria um bucket público para as fotos do cardápio e restringe uploads e remoções à pasta do usuário autenticado. As fotos desse bucket são públicas para quem tiver o endereço; não use o bucket para imagens privadas.

Em **Produtos e cardápio**, edite ou cadastre um lanche e escolha uma foto JPG, PNG ou WebP de até 10 MB. O navegador reduz a imagem para no máximo 1200 pixels no lado maior e 512 KB, converte para JPEG e envia ao Supabase. É possível substituir ou remover a foto. As alterações só ficam disponíveis no cardápio depois da sincronização. Sem foto, o visual Elvis mantém uma imagem ilustrativa e o cardápio original usa o ícone de lanche.

Fotos antigas são removidas depois que o produto e o cardápio são sincronizados. Se a sincronização ou remoção falhar, uma foto antiga pode permanecer no Storage; verifique o aviso e o bucket antes de remover arquivos manualmente. Acompanhe o armazenamento e a transferência de dados na página **Usage** da organização no Supabase. Excluir imagens ainda referenciadas pode quebrar a exibição no cardápio.

## Como o Pix funciona

- O cliente escolhe Pix online no checkout, informa um e-mail e recebe o QR Code e o código Pix copia e cola.
- O servidor valida produtos, adicionais, taxa, total e disponibilidade antes de criar a cobrança Pix no Mercado Pago.
- O cardápio consulta o status do pagamento; o webhook também atualiza o pedido. Apenas pagamentos aprovados são marcados como recebidos.
- Pagamentos Pix aprovados são associados ao caixa aberto na data da confirmação. Para pedidos em dinheiro, registre o recebimento no sistema.
- Um código Pix criado antes do fechamento ainda pode ser pago depois que o caixa fechar. Confira os pedidos Pix pendentes e concilie pagamentos posteriores; o fechamento não cancela cobranças já geradas.
- Para usar somente dinheiro, não é necessário conectar o Mercado Pago.
