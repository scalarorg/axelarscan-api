const {
  BigNumber,
  utils: { formatUnits, parseUnits },
} = require('ethers');
const axios = require('axios');
const _ = require('lodash');
const moment = require('moment');
const config = require('config-yml');
const {
  saveTimeSpent,
} = require('./utils');
const {
  read,
  write,
} = require('../index');
const assets_price = require('../assets-price');
const {
  sleep,
  equals_ignore_case,
  get_granularity,
  normalize_original_chain,
  normalize_chain,
  getBlockTime,
  getProvider,
} = require('../../utils');

const environment = process.env.ENVIRONMENT || config?.environment;

const data = require('../../data');
const evm_chains_data = data?.chains?.[environment]?.evm || [];
const cosmos_chains_data = data?.chains?.[environment]?.cosmos || [];
const chains_data = _.concat(
  evm_chains_data,
  cosmos_chains_data,
);
const axelarnet = chains_data.find(c => c?.id === 'axelarnet');
const cosmos_non_axelarnet_chains_data = cosmos_chains_data.filter(c => c?.id !== axelarnet.id);
const assets_data = data?.assets?.[environment] || [];

const {
  endpoints,
} = { ...config?.[environment] };

module.exports = async (
  params = {},
) => {
  let response;

  const {
    txHash,
    sourceChain,
    recipientAddress,
    asset,
  } = { ...params };
  let {
    depositAddress,
    query,
  } = { ...params };

  if (txHash) {
    const _response = await read(
      'transfers',
      {
        match: { 'source.id': txHash },
      },
      {
        size: 1,
      },
    );

    let data = _.head(_response?.data);

    if (!data) {
      let created_at = moment().valueOf();

      if (txHash.startsWith('0x')) {
        for (const chain_data of evm_chains_data) {
          if (
            !sourceChain ||
            equals_ignore_case(chain_data?.id, sourceChain)
          ) {
            const provider = getProvider(chain_data);
            const {
              chain_id,
            } = { ...chain_data };

            try {
              const transaction = await provider.getTransaction(txHash);
              const {
                blockNumber,
                from,
                to,
                input,
              } = { ...transaction };

              if (blockNumber) {
                const block_timestamp = await getBlockTime(
                  provider,
                  blockNumber,
                );

                if (block_timestamp) {
                  created_at = block_timestamp * 1000;
                }

                let __response;

                const receipt = await provider.getTransactionReceipt(txHash);
                const {
                  logs,
                } = { ...receipt };

                const topics = _.reverse(
                  _.cloneDeep(logs || [])
                    .flatMap(l => l?.topics || [])
                )
                .filter(t => t?.startsWith('0x000000000000000000000000'))
                .map(t => t.replace('0x000000000000000000000000', '0x'));

                let found = false;

                for (const topic of topics) {
                  __response = await read(
                    'deposit_addresses',
                    {
                      match: { deposit_address: topic },
                    },
                    {
                      size: 1,
                    },
                  );

                  if (_.head(__response?.data)) {
                    depositAddress = topic;
                    found = true;
                    break;
                  }
                }

                if (
                  !found &&
                  depositAddress
                ) {
                  __response = await read(
                    'deposit_addresses',
                    {
                      match: { deposit_address: depositAddress },
                    },
                    {
                      size: 1,
                    },
                  );
                }

                if (depositAddress) {
                  const _amount = _.head(
                    (logs || [])
                      .map(l => l?.data)
                      .filter(d => d?.length >= 64)
                      .map(d =>
                        d.substring(
                          d.length - 64,
                        )
                        .replace(
                          '0x',
                          '',
                        )
                        .replace(
                          /^0+/,
                          '',
                        )
                      )
                      .filter(d => {
                        try {
                          d = BigNumber.from(`0x${d}`);
                          return true;
                        } catch (error) {
                          return false;
                        }
                      })
                  );

                  const source = {
                    id: txHash,
                    type: 'evm_transfer',
                    status_code: 0,
                    status: 'success',
                    height: blockNumber,
                    created_at: get_granularity(created_at),
                    sender_chain: chain_data?.id,
                    sender_address: from,
                    recipient_address: depositAddress,
                    amount: BigNumber.from(`0x${transaction.data?.substring(10 + 64) || input?.substring(10 + 64) || _amount || '0'}`).toString(),
                    denom: assets_data.find(a => a?.contracts?.findIndex(c => equals_ignore_case(c?.contract_address, to)) > -1)?.id,
                  };

                  const link = _.head(__response?.data);
                  const {
                    id,
                    original_sender_chain,
                    original_recipient_chain,
                    sender_chain,
                    recipient_chain,
                    sender_address,
                    asset,
                  } = { ...link };
                  let {
                    denom,
                    price,
                  } = { ...link };

                  if (link) {
                    let updated = false;

                    if (!equals_ignore_case(sender_address, from)) {
                      link.sender_address = from;
                      updated = true;
                    }

                    denom = source.denom ||
                      asset ||
                      denom;

                    if (
                      !price ||
                      price <= 0 ||
                      !equals_ignore_case(link.denom, denom) ||
                      ['uluna'].includes(denom)
                    ) {
                      const ___response = await assets_price(
                        {
                          chain: original_sender_chain,
                          denom,
                          timestamp: created_at,
                        },
                      );

                      const _price = _.head(___response)?.price;
                      if (_price) {
                        price = _price;
                        link.price = price;
                        link.denom = denom;
                        updated = true;
                      }
                    }

                    if (updated) {
                      await write(
                        'deposit_addresses',
                        id,
                        link,
                      );
                    }
                  }

                  source.original_sender_chain = original_sender_chain ||
                    normalize_original_chain(
                      source.sender_chain ||
                      sender_chain
                    );
                  source.original_recipient_chain = original_recipient_chain ||
                    normalize_original_chain(
                      source.recipient_chain ||
                      recipient_chain
                    );

                  if (link) {
                    source.recipient_chain = normalize_chain(
                      recipient_chain ||
                      source.recipient_chain
                    );
                    source.denom = source.denom ||
                      asset;

                    if (
                      source.denom &&
                      typeof source.amount === 'string'
                    ) {
                      const asset_data = assets_data.find(a => equals_ignore_case(a?.id, source.denom));

                      const {
                        contracts,
                      } = { ...asset_data };
                      let {
                        decimals,
                      } = { ...asset_data };

                      decimals = contracts?.find(c =>
                        c?.chain_id === chain_id
                      )?.decimals ||
                        decimals ||
                        18;

                      if (asset_data) {
                        source.amount = Number(
                          formatUnits(
                            BigNumber.from(source.amount).toString(),
                            decimals,
                          )
                        );
                      }
                    }

                    if (price && typeof source.amount === 'number') {
                      source.value = source.amount * price;
                    }

                    if (source.recipient_address) {
                      await write(
                        'transfers',
                        `${source.id}_${source.recipient_address}`.toLowerCase(),
                        {
                          source,
                          link,
                        },
                      );
                    }
                  }

                  data = {
                    source,
                    link,
                  };
                }

                break;
              }
            } catch (error) {}
          }
        }
      }
      else {
        for (const chain_data of cosmos_chains_data) {
          if (
            !sourceChain ||
            equals_ignore_case(chain_data?.id, sourceChain)
          ) {
            let found = false;

            const {
              cosmostation,
            } = { ...chain_data?.endpoints };

            const _lcds = _.concat(
              cosmostation,
              [chain_data?.endpoints?.lcd],
              chain_data?.endpoints?.lcds || [],
            ).filter(l => l);

            for (const _lcd of _lcds) {
              const lcd = axios.create({ baseURL: _lcd });

              const is_cosmostation = _lcd === cosmostation;

              try {
                const transaction = await lcd.get(
                  is_cosmostation ?
                    `/tx/hash/${txHash}` :
                    `/cosmos/tx/v1beta1/txs/${txHash}`,
                ).catch(error => { return { data: { error } }; });

                const tx_response = is_cosmostation ?
                  transaction?.data?.data :
                  transaction?.data?.tx_response;

                const {
                  tx,
                  txhash,
                  code,
                  height,
                  timestamp,
                } = { ...tx_response };
                const {
                  messages,
                } = { ...tx?.body };

                if (messages) {
                  created_at = moment(timestamp).utc().valueOf();
                  const amount_data = messages.find(m => m?.token)?.token;

                  const source = {
                    id: txhash,
                    type: 'ibc_transfer',
                    status_code: code,
                    status: code ?
                      'failed' :
                      'success',
                    height: Number(height),
                    created_at: get_granularity(created_at),
                    sender_chain: chain_data?.id,
                    sender_address: messages.find(m => m?.sender)?.sender,
                    recipient_address: messages.find(m => m?.receiver)?.receiver,
                    amount: amount_data?.amount,
                    denom: amount_data?.denom,
                  };

                  const {
                    sender_address,
                    recipient_address,
                  } = { ...source };

                  if (
                    recipient_address?.length >= 65 &&
                    txhash &&
                    source.amount
                  ) {
                    const __response = await read(
                      'deposit_addresses',
                      {
                        match: { deposit_address: recipient_address },
                      },
                      {
                        size: 1,
                      },
                    );

                    const link = _.head(__response?.data);
                    const {
                      id,
                      original_recipient_chain,
                      sender_chain,
                      recipient_chain,
                      asset,
                    } = { ...link };
                    let {
                      original_sender_chain,
                      denom,
                      price,
                    } = { ...link };

                    let link_updated = false;

                    if (
                      equals_ignore_case(original_sender_chain, axelarnet.id) ||
                      cosmos_non_axelarnet_chains_data.findIndex(c => c?.overrides?.[original_sender_chain]) > -1
                    ) {
                      const chain_data = cosmos_non_axelarnet_chains_data.find(c => sender_address?.startsWith(c?.prefix_address));
                      const {
                        overrides,
                      } = { ...chain_data };

                      if (chain_data) {
                        original_sender_chain =
                          Object.values({ ...overrides })
                            .find(o =>
                              o?.endpoints?.lcd === _lcd ||
                              o?.endpoints?.lcds?.includes(_lcd)
                            )?.id ||
                            _.last(Object.keys({ ...overrides })) ||
                            chain_data.id;

                        if (link) {
                          link_updated = link.original_sender_chain !== original_sender_chain;
                          link.original_sender_chain = original_sender_chain;
                        }
                      }
                    }

                    source.original_sender_chain = original_sender_chain ||
                      normalize_original_chain(
                        source.sender_chain ||
                        sender_chain
                      );
                    source.original_recipient_chain = original_recipient_chain ||
                      normalize_original_chain(
                        source.recipient_chain ||
                        recipient_chain
                      );

                    if (link) {
                      source.recipient_chain = normalize_chain(
                        recipient_chain ||
                        source.recipient_chain
                      );
                      source.denom = source.denom ||
                        asset;

                      if (source.denom) {
                        const asset_data = assets_data.find(a =>
                          equals_ignore_case(a?.id, source.denom) ||
                          a?.ibc?.findIndex(i =>
                            i?.chain_id === chain_data?.id &&
                            equals_ignore_case(i?.ibc_denom, source.denom)
                          ) > -1
                        );

                        const {
                          ibc,
                        } = { ...asset_data };
                        let {
                          decimals,
                        } = { ...asset_data };

                        decimals = ibc?.find(i =>
                          i?.chain_id === chain_data?.id
                        )?.decimals ||
                          decimals ||
                          6;

                        if (asset_data) {
                          if (typeof source.amount === 'string') {
                            source.amount = Number(
                              formatUnits(
                                BigNumber.from(source.amount).toString(),
                                decimals,
                              )
                            );
                          }

                          source.denom = asset_data.id ||
                            source.denom;

                          denom = source.denom ||
                            asset ||
                            denom;
                        }
                        else {
                          denom = asset ||
                            denom;
                        }
                      }
                      else {
                        denom = asset ||
                          denom;
                      }
                    }

                    if (
                      link &&
                      (
                        !price ||
                        price <= 0 ||
                        !equals_ignore_case(link.denom, denom) ||
                        ['uluna'].includes(denom)
                      )
                    ) {
                      const ___response = await assets_price(
                        {
                          chain: equals_ignore_case(original_sender_chain, axelarnet.id) ?
                            original_recipient_chain :
                            original_sender_chain,
                          denom,
                          timestamp: created_at,
                        },
                      );

                      const _price = _.head(___response)?.price;
                      if (_price) {
                        price = _price;
                        link.price = price;
                        link.denom = denom;
                        link_updated = true;
                      }
                    }

                    if (link_updated) {
                      await write(
                        'deposit_addresses',
                        id,
                        link,
                      );
                    }

                    if (
                      price > 0 &&
                      typeof source.amount === 'number'
                    ) {
                      source.value = source.amount * price;
                    }

                    if (source.recipient_address) {
                      await write(
                        'transfers',
                        `${source.id}_${source.recipient_address}`.toLowerCase(),
                        {
                          source,
                          link: link ||
                            undefined,
                        },
                      );
                    }

                    data = {
                      source,
                      link,
                    };
                  }

                  found = true;
                  break;
                }
              } catch (error) {}
            }

            if (found) {
              break;
            }
          }
        }
      }
    }
    else if (data) {
      const {
        source,
      } = { ...data };
      const {
        recipient_address,
      } = { ...source };

      let __response = await read(
        'deposit_addresses',
        {
          match: { deposit_address: recipient_address || depositAddress },
        },
        {
          size: 1,
        },
      );

      let link = _.head(__response?.data);
      let {
        id,
        txhash,
        original_sender_chain,
        original_recipient_chain,
        sender_chain,
        recipient_chain,
        sender_address,
        asset,
        denom,
        price,
      } = { ...link };

      if (
        txhash &&
        typeof price !== 'number' &&
        endpoints?.api
      ) {
        const api = axios.create({ baseURL: endpoints.api });
        await api.post(
          '',
          {
            module: 'lcd',
            path: `/cosmos/tx/v1beta1/txs/${txhash}`,
          },
        ).catch(error => { return { data: { error } }; });

        await sleep(0.5 * 1000);

        __response = await read(
          'deposit_addresses',
          {
            match: { deposit_address: recipient_address || depositAddress },
          },
          {
            size: 1,
          },
        );

        if (_.head(__response?.data)) {
          link = _.head(__response.data);
          id = link.id;
          txhash = link.txhash;
          original_sender_chain = link.original_sender_chain;
          original_recipient_chain = link.original_recipient_chain;
          sender_chain = link.sender_chain;
          recipient_chain = link.recipient_chain;
          asset = link.asset;
          denom = link.denom;
          price = link.price;
        }
      }

      if (source) {
        if (source.sender_address) {
          sender_address = source.sender_address;
          sender_chain = normalize_chain(
            cosmos_non_axelarnet_chains_data.find(c => sender_address?.startsWith(c?.prefix_address))?.id ||
            sender_chain ||
            source.sender_chain
          );
          if (!original_sender_chain?.startsWith(sender_chain)) {
            original_sender_chain = sender_chain;
          }

          if (link) {
            link.sender_address = sender_address;
            link.sender_chain = source.sender_chain;
            link.original_sender_chain = original_sender_chain;

            await write(
              'deposit_addresses',
              id,
              link,
            );
          }
        }

        source.sender_chain = sender_chain ||
          source.sender_chain;
        source.recipient_chain = recipient_chain ||
          source.recipient_chain;
        source.denom = source.denom ||
          asset;
        source.original_sender_chain = original_sender_chain ||
          normalize_original_chain(
            source.sender_chain ||
            sender_chain
          );
        source.original_recipient_chain = original_recipient_chain ||
          normalize_original_chain(
            source.recipient_chain ||
            recipient_chain
          );

        if (source.denom) {
          const chain_data = chains_data.find(c => equals_ignore_case(c?.id, source.sender_chain));
          const asset_data = assets_data.find(a =>
            equals_ignore_case(a?.id, source.denom) ||
            a?.ibc?.findIndex(i => i?.chain_id === chain_data?.id && equals_ignore_case(i?.ibc_denom, source.denom)) > -1
          );

          if (
            chain_data &&
            asset_data
          ) {
            const {
              chain_id,
            } = { ...chain_data };
            const {
              contracts,
              ibc,
            } = { ...asset_data };
            let {
              decimals,
            } = { ...asset_data };

            decimals =
              contracts?.find(c =>
                c?.chain_id === chain_id
              )?.decimals ||
              ibc?.find(i =>
                i?.chain_id === chain_data?.id
              )?.decimals ||
                decimals ||
                6;

            if (typeof source.amount === 'string') {
              source.amount = Number(
                formatUnits(
                  BigNumber.from(source.amount).toString(),
                  decimals,
                )
              );
            }

            source.denom = asset_data.id ||
              source.denom;

            denom = source.denom ||
              asset ||
              denom;

            if (
              !source.fee &&
              endpoints?.lcd
            ) {
              const lcd = axios.create({ baseURL: endpoints.lcd });

              const ___response = await lcd.get(
                '/axelar/nexus/v1beta1/transfer_fee',
                {
                  params: {
                    source_chain: original_sender_chain,
                    destination_chain: original_recipient_chain,
                    amount: `${parseUnits((source.amount || 0).toString(), decimals).toString()}${asset_data.id}`,
                  },
                },
              ).catch(error => { return { data: { error } }; });

              const {
                amount,
              } = { ...___response?.data?.fee };

              if (amount) {
                source.fee = Number(
                  formatUnits(
                    BigNumber.from(amount).toString(),
                    decimals,
                  )
                );
              }
            }
          }
        }

        if (
          typeof source.amount === 'number' &&
          typeof source.fee === 'number'
        ) {
          if (source.amount < source.fee) {
            source.insufficient_fee = true;
          }
          else {
            source.insufficient_fee = false;
            source.amount_received = source.amount - source.fee;
          }
        }
      }

      if (
        (
          !price ||
          price <= 0 ||
          !equals_ignore_case(link?.denom, denom) ||
          ['uluna'].includes(denom)
        ) &&
        (
          link ||
          source
        )
      ) {
        const ___response = await assets_price(
          {
            chain: original_sender_chain ||
              source?.original_sender_chain,
            denom: denom ||
              asset ||
              source?.asset ||
              source?.denom,
            timestamp:  moment(source?.created_at?.ms || undefined).utc().valueOf(),
          },
        );

        const _price = _.head(___response)?.price;
        if (_price) {
          price = _price;
          if (link) {
            link.price = price;
            link.denom = denom;

            await write(
              'deposit_addresses',
              id,
              link,
            );
          }
        }
      }

      if (source) {
        if (
          price > 0 &&
          typeof source.amount === 'number'
        ) {
          source.value = source.amount * price;
        }

        if (source.recipient_address) {
          await write(
            'transfers',
            `${source.id}_${source.recipient_address}`.toLowerCase(),
            {
              source,
              link,
            },
          );
        }
      }

      data = {
        ...data,
        source,
        link,
      };
    }

    response = [data]
      .filter(t => t);
  }
  else if (
    depositAddress ||
    recipientAddress
  ) {
    const _response = await read(
      'deposit_addresses',
      {
        bool: {
          must: [
            { match: { deposit_address: depositAddress } },
            { match: { recipient_address: recipientAddress } },
            { match: { asset } },
          ].filter(m => Object.values(m.match)
            .filter(v => v).length > 0
          ),
        },
      },
      {
        size: 1000,
        sort: [{ height: 'desc' }],
      },
    );

    const links = _response?.data ||
      [];

    if (links.length > 0) {
      const should = [];

      for (const link of links) {
        const {
          deposit_address,
        } = { ...link };

        if (
          deposit_address &&
          should.findIndex(s => equals_ignore_case(s.match['source.recipient_address'], deposit_address)) < 0
        ) {
          should.push({ match: { 'source.recipient_address': deposit_address } });
        }
      }

      const __response = await read(
        'transfers',
        {
          bool: {
            should,
            minimum_should_match: 1,
          },
        },
        {
          size: 1000,
        },
      );

      let {
        data,
      } = { ...__response };

      data = data?.filter(d => d)
        .map(d => {
          const {
            recipient_address,
          } = { ...d?.source };

          return {
            ...d,
            link: links.find(l => equals_ignore_case(l?.deposit_address, recipient_address)),
          };
        });

      if (!(data?.length > 0)) {
        data = links.map(l => {
          return {
            link: l,
          };
        });
      }

      response = data;
    }
    else {
      response = [];
    }
  }

  if (Array.isArray(response)) {
    response = response.map(d => {
      const {
        source,
        link,
        confirm_deposit,
        vote,
        sign_batch,
        ibc_send,
        axelar_transfer,
      } = { ...d };
      const {
        amount,
        value,
      } = { ...source };
      let {
        price,
      } = { ...link };

      if (
        typeof price !== 'number' &&
        typeof amount === 'number' &&
        typeof value === 'number'
      ) {
        price = value / amount;
      }

      return {
        ...d,
        link: link && {
          ...link,
          price,
        },
        status: ibc_send ?
          ibc_send.failed_txhash &&
          !ibc_send.ack_txhash ?
            'ibc_failed' :
            ibc_send.recv_txhash ?
              'executed' :
              'ibc_sent' :
          sign_batch?.executed ?
            'executed' :
             sign_batch ?
              'batch_signed' :
              axelar_transfer ?
                'executed' :
                vote ?
                  'voted' :
                  confirm_deposit ?
                    'deposit_confirmed' :
                    'asset_sent',
      };
    });

    if (
      response.length > 0 &&
      endpoints?.api
    ) {
      const api = axios.create({ baseURL: endpoints.api });

      for (const d of response) {
        const {
          source,
          confirm_deposit,
          vote,
          ibc_send,
          status,
        } = { ...d };
        let {
          sign_batch,
        } = { ...d };
        const {
          id,
          recipient_chain,
          recipient_address,
        } = { ...source };
        let {
          height,
        } = { ...vote };

        height = ibc_send?.height ||
          height ||
          confirm_deposit?.height;

        if (
          cosmos_chains_data.findIndex(c => equals_ignore_case(c?.id, recipient_chain)) > -1 &&
          height &&
          [
            'voted',
            'deposit_confirmed',
            'ibc_sent',
          ].includes(status)
        ) {
          for (let i = 1; i <= 7; i++) {
            api.post(
              '',
              {
                module: 'lcd',
                path: '/cosmos/tx/v1beta1/txs',
                events: `tx.height=${height + i}`,
              },
            ).catch(error => { return { data: { error } }; });
          }
        }
        else if (
          evm_chains_data.findIndex(c => equals_ignore_case(c?.id, recipient_chain)) > -1 &&
          [
            'batch_signed',
            'voted',
          ].includes(status)
        ) {
          const transfer_id = vote?.transfer_id ||
            confirm_deposit?.transfer_id ||
            d.transfer_id;

          if (transfer_id) {
            const command_id = transfer_id
              .toString(16)
              .padStart(64, '0');

            const _response = await read(
              'batches',
              {
                bool: {
                  must: [
                    { match: { chain: recipient_chain } },
                    { match: { status: 'BATCHED_COMMANDS_STATUS_SIGNED' } },
                    { match: { command_ids: command_id } },
                  ],
                },
              },
              {
                size: 1,
              },
            );

            const batch = _.head(_response?.data);

            if (batch) {
              const {
                batch_id,
                commands,
                created_at,
              } = { ...batch };

              const command = commands?.find(c => c?.id === command_id);

              let {
                executed,
                transactionHash,
                transactionIndex,
                logIndex,
                block_timestamp,
              } = { ...command };

              if (!executed) {
                const chain_data = evm_chains_data.find(c => equals_ignore_case(c?.id, recipient_chain));
                const provider = getProvider(chain_data);
                const {
                  chain_id,
                  gateway_address,
                } = { ...chain_data };

                const gateway_contract = gateway_address &&
                  new Contract(
                    gateway_address,
                    IAxelarGateway.abi,
                    provider,
                  );

                try {
                  if (gateway_contract) {
                    executed = await gateway_contract.isCommandExecuted(`0x${command_id}`);
                  }
                } catch (error) {}
              }

              if (!transactionHash) {
                const __response = await read(
                  'command_events',
                  {
                    bool: {
                      must: [
                        { match: { chain: recipient_chain } },
                        { match: { command_id } },
                      ],
                    },
                  },
                  {
                    size: 1,
                  },
                );

                const command_event = _.head(__response?.data);

                if (command_event) {
                  transactionHash = command_event.transactionHash;
                  transactionIndex = command_event.transactionIndex;
                  logIndex = command_event.logIndex;
                  block_timestamp = command_event.block_timestamp;
                }
              }

              sign_batch = {
                ...sign_batch,
                chain: recipient_chain,
                batch_id,
                created_at,
                command_id,
                transfer_id,
                executed,
                transactionHash,
                transactionIndex,
                logIndex,
                block_timestamp,
              };
            }

            if (recipient_address) {
              const _id = `${id}_${recipient_address}`.toLowerCase();

              await write(
                'transfers',
                _id,
                {
                  ...d,
                  sign_batch: sign_batch ||
                    undefined,
                },
              );

              await saveTimeSpent(
                _id,
              );
            }
          }
        }
      }
    }
  }

  return response;
};