/* Copyright(c) 2018-2023 Philip Mulcahy. */

'use strict';

import * as util from './util';
import * as extpay from './extpay_client'; 
import * as msg from './message_types';
import * as settings from './settings';

const content_ports: Record<number, any> = {};

function broadcast_to_content_pages(msg: any) {
  Object.values(content_ports).forEach( port =>
    port.postMessage(msg)
  );
}

let control_port: msg.ControlPort|null = null;

let advertised_periods: number[] = [];

function registerConnectionListener() {
  chrome.runtime.onConnect.addListener( port => {
    console.log('new connection from ' + port.name);
    switch(port.name) {
      case 'azad_inject':
        port.onDisconnect.addListener( () => {
            delete content_ports[port?.sender?.tab?.id!];
        } );
        port.onMessage.addListener( msg => {
          switch(msg.action) {
            case 'advertise_periods':
              console.log(
                'forwarding advertise_periods',
                msg.period
              );
              advertised_periods = [
                ...Array.from(new Set<number>(
                    advertised_periods.concat(msg.periods))
                )
              ].sort((a, b) => a-b);
              advertisePeriods();
              break;
            case 'statistics_update':
              if (control_port) {
                try {
                  control_port?.postMessage(msg);
                } catch (ex) {
                  console.debug(
                    'could not post stats message to control port'
                  );
                }
              }
              break;
            default:
              console.warn('unknown action: ' + msg.action);
              break;
          }
        } );
        content_ports[port?.sender?.tab?.id!] = port;
        break;
      case 'azad_control':
        control_port = port;
        port.onMessage.addListener( msg => {
          switch(msg.action) {
            case 'scrape_years':
              console.log(
                'forwarding scrape_years',
                msg.years
              );
              broadcast_to_content_pages(msg);
              break;
            case 'scrape_range':
              console.log(
                'forwarding scrape_range',
                msg.start_date,
                msg.end_date,
              );
              broadcast_to_content_pages(msg);
              break;
            case 'check_feature_authorized':
              handleAuthorisationRequest(
                msg.feature_id,
                control_port);
              break;
            case 'show_payment_ui':
              console.log(
                'got show_payment_ui request');
              extpay.display_payment_ui();
              break;
            case 'clear_cache':
              broadcast_to_content_pages(msg);
              break;
            case 'force_logout':
              broadcast_to_content_pages(msg);
              break;
            case 'abort':
              broadcast_to_content_pages(msg);
              break;
            default:
              console.warn('unknown action: ' + msg.action);
              break;
          }
        });
        advertisePeriods();
        break;
      default:
        console.warn('unknown port name: ' + port.name);
    }
  });
}

function registerExternalConnectionListener() {
  const ALLOWED_EXTENSION_IDS: (string|undefined)[] = [
    'lanjobgdpfchcekdbfelnkhcbppkpldm',  // azad_test dev Philip@ball.local
    'jjegocddaijoaiooabldmkcmlfdahkoe',  // EZP Regular Release 
    'ccffmpedppmmccbelbkmembkkggbmnce',  // EZP Early testers Release
    'ciklnhigjmbmehniheaolibcchfmabfp'  // EZP Alpha Tester Release
  ];

  chrome.runtime.onMessageExternal.addListener(
    function(
      message: any,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: any) => void
    ){
      if (!ALLOWED_EXTENSION_IDS.includes(sender.id))
        return;  // don't allow access
      else if (message.action == 'get_items_3m') {
        const month_count = 3;
        const end_date = new Date();
        const start_date = util.subtract_months(end_date, month_count);
        console.log('sending scrape_range', start_date, end_date);
        const msg = {
          action: 'scrape_range_and_dump_items',
          start_date: start_date,
          end_date: end_date,
        };
        broadcast_to_content_pages(msg);
        sendResponse({status: 'ack'});
      } else {
        sendResponse({status: 'unsupported'});
      }
      return true;  // Incompletely documented, but seems to be needed to allow
                    // sendResponse calls to succeed.
    }
  );
}

function registerRightClickActions() {
  chrome.contextMenus.create( {
    id: 'save_order_debug_info',
    title: 'save order debug info',
    contexts: ['link']
  } );
  chrome.contextMenus.onClicked.addListener( info => {
    console.log('context menu item: ' + info.menuItemId + ' clicked;');
    if (info.menuItemId == 'save_order_debug_info') {
      if ( /orderID=/.test(info.linkUrl!) ) {
        const match =info?.linkUrl?.match(/.*orderID=([0-9A-Z-]*)$/);
        const order_id = match![1];
        if (match) {
          Object.values(content_ports).forEach( port => {
            port.postMessage({
              action: 'dump_order_detail',
              order_id: order_id
            });
          });
        }
      }
      else if ( /search=/.test(info.linkUrl!) ) {
        const match =info?.linkUrl?.match(/.*search=([0-9A-Z-]*)$/);
        const order_id = match![1];
        if (match) {
          Object.values(content_ports).forEach( port => {
            port.postMessage({
              action: 'dump_order_detail',
              order_id: order_id
            });
          });
        }
      }
    }
  } );
}

function registerMessageListener() {
  chrome.runtime.onMessage.addListener( (request, sender) => {
    console.log(
      sender.tab
          ? 'from a content script:' + sender.tab.url
          : 'from the extension'
    );
    switch(request.action) {
      case 'remove_cookie':
        chrome.cookies.remove(
          {
            url: request.cookie_url,
            name: request.cookie_name
          },
          () => console.log(
            'removed cookie ' + request.cookie_url + ' ' +
            request.cookie_name
          )
        )
        break;
      case 'open_tab':
        console.log('opening: ' + request.url);
        chrome.tabs.create( { url: request.url } );
        break;
      default:
        console.warn('unknown action: ' + request.action);
    }
  });
}

function advertisePeriods() {
  if (control_port) {
    console.log('advertising periods', advertised_periods);
    control_port.postMessage({
      action: 'advertise_periods',
      periods: advertised_periods,
    });
  } else {
    console.log('Cannot advertise periods yet: no control port is set.');
  }
}

async function handleAuthorisationRequest(
  feature_id: string,
  control_port: msg.ControlPort|null,
): Promise<void> {
  const authorised = feature_id == 'premium_preview' ?
    await extpay.check_authorised() :
    false;
  settings.storeBoolean('preview_features_enabled', authorised);
	control_port?.postMessage({
		action: 'authorisation_status',
		authorisation_status: authorised
	});
}

registerConnectionListener();
registerRightClickActions();
registerMessageListener();
registerExternalConnectionListener();
