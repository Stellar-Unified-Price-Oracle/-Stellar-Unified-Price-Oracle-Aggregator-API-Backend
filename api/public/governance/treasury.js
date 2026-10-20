(function () {
  'use strict';

  var ENDPOINT = '/api/v1/governance/treasury?limit=200';

  function el(id) {
    return document.getElementById(id);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function cell(text, className) {
    var td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  function badge(text, variant) {
    var span = document.createElement('span');
    span.className = 'badge' + (variant ? ' ' + variant : '');
    span.textContent = text;
    return span;
  }

  function formatTimestamp(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function setStatus(text, variant) {
    var node = el('status-badge');
    node.textContent = text;
    node.className = 'badge' + (variant ? ' ' + variant : '');
  }

  function renderSummary(report) {
    el('as-of').textContent = formatTimestamp(report.asOf);
    el('freshness').textContent =
      'Age ' + report.freshness.ageHours + 'h · ' + report.freshness.status;
    el('cadence').textContent = report.updateCadence.hours + 'h';
    el('next-update').textContent = 'Next expected ' + formatTimestamp(report.updateCadence.nextExpectedAt);

    var totals = report.reconciliation.totals;
    el('assets-reconciled').textContent = totals.reconciledAssets + ' / ' + totals.assets;
    el('entries-count').textContent =
      totals.entries + ' entries · ' + report.provenance.entriesWithSource + ' with source references';
    el('provenance').textContent = report.provenance.complete ? 'Complete' : 'Incomplete';
    el('policy-version').textContent = 'Policy ' + report.policyAllocation.version;

    el('source-as-of').textContent = formatTimestamp(report.asOf);
    el('policy-reference').textContent = report.policyAllocation.reference;

    if (report.status === 'reconciled') {
      setStatus('Reconciled', 'ok');
    } else {
      setStatus('Unreconciled', 'bad');
    }
  }

  function renderBalances(report) {
    var body = el('balances-body');
    clear(body);

    if (report.reconciliation.assets.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = cell('No treasury positions are published.', 'muted');
      emptyCell.colSpan = 8;
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
      return;
    }

    report.reconciliation.assets.forEach(function (asset) {
      var row = document.createElement('tr');
      row.appendChild(cell(asset.asset));
      row.appendChild(cell(asset.openingBalance.display, 'num'));
      row.appendChild(cell(asset.inflows.display, 'num'));
      row.appendChild(cell(asset.outflows.display, 'num'));
      row.appendChild(cell(asset.expectedClosing.display, 'num'));
      row.appendChild(cell(asset.closingBalance.display, 'num'));
      row.appendChild(cell(asset.delta.display, 'num'));

      var status = document.createElement('td');
      status.appendChild(
        asset.reconciled ? badge('Reconciled', 'ok') : badge('Break', 'bad'),
      );
      row.appendChild(status);
      body.appendChild(row);
    });
  }

  function renderPolicy(report) {
    var container = el('policy-sections');
    clear(container);

    if (report.policyAllocation.byAsset.length === 0) {
      var message = document.createElement('p');
      message.className = 'muted';
      message.textContent = 'No policy allocation data is published.';
      container.appendChild(message);
      return;
    }

    report.policyAllocation.byAsset.forEach(function (assetPolicy) {
      var wrapper = document.createElement('div');
      wrapper.className = 'panel';
      wrapper.style.marginBottom = '1rem';

      var heading = document.createElement('h3');
      heading.textContent = assetPolicy.asset + ' outflows (' + assetPolicy.totalOutflow.display + ')';
      heading.style.fontSize = '0.95rem';
      heading.style.marginBottom = '0.6rem';
      wrapper.appendChild(heading);

      var table = document.createElement('table');
      var thead = document.createElement('thead');
      var headRow = document.createElement('tr');
      ['Policy', 'Target bps', 'Actual bps', 'Deviation bps', 'Outflow', 'Status'].forEach(
        function (label, index) {
          var th = document.createElement('th');
          th.textContent = label;
          if (index > 0 && index < 5) th.className = 'num';
          headRow.appendChild(th);
        },
      );
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      assetPolicy.allocations.forEach(function (allocation) {
        var row = document.createElement('tr');
        row.appendChild(cell(allocation.policy));
        row.appendChild(cell(String(allocation.targetShareBps), 'num'));
        row.appendChild(cell(String(allocation.actualShareBps), 'num'));
        row.appendChild(cell(String(allocation.deviationBps), 'num'));
        row.appendChild(cell(allocation.outflow.display, 'num'));

        var status = document.createElement('td');
        status.appendChild(
          allocation.withinTolerance ? badge('Within tolerance', 'ok') : badge('Drift', 'warn'),
        );
        row.appendChild(status);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      wrapper.appendChild(table);
      container.appendChild(wrapper);
    });
  }

  function renderFindings(report) {
    var container = el('findings');
    clear(container);
    var findings = report.breaks.concat(report.warnings);

    if (findings.length === 0) {
      var none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No reconciliation breaks or warnings.';
      container.appendChild(none);
      return;
    }

    var list = document.createElement('ul');
    list.className = 'findings';
    findings.forEach(function (finding) {
      var item = document.createElement('li');
      if (finding.severity === 'warning') item.className = 'warning';
      var prefix = finding.severity === 'warning' ? 'Warning' : 'Break';
      item.textContent =
        prefix + ' · ' + finding.code + (finding.asset ? ' · ' + finding.asset : '') + ' — ' + finding.detail;
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  function renderLedger(report) {
    var body = el('ledger-body');
    clear(body);

    if (report.ledger.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = cell('No ledger entries are published for this period.', 'muted');
      emptyCell.colSpan = 7;
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
    }

    report.ledger.forEach(function (entry) {
      var row = document.createElement('tr');
      row.appendChild(cell(formatTimestamp(entry.timestamp)));
      row.appendChild(cell(entry.direction));
      row.appendChild(cell(entry.asset));
      row.appendChild(cell(entry.amount.display, 'num'));
      row.appendChild(cell(entry.category));
      row.appendChild(cell(entry.policy));

      var sourceCell = document.createElement('td');
      if (entry.source && entry.source.url) {
        var link = document.createElement('a');
        link.href = entry.source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = entry.source.ref;
        sourceCell.appendChild(link);
      } else if (entry.source) {
        sourceCell.textContent = entry.source.ref;
      } else {
        sourceCell.appendChild(badge('Missing', 'bad'));
      }
      row.appendChild(sourceCell);
      body.appendChild(row);
    });

    el('ledger-note').textContent =
      'Showing ' +
      report.ledger.length +
      ' of ' +
      report.provenance.entries +
      ' entries. Reconciliation always uses the full period, not this page of rows.';
  }

  function renderError(message) {
    setStatus('Unavailable', 'bad');
    ['balances-body', 'ledger-body'].forEach(function (id) {
      var body = el(id);
      clear(body);
      var row = document.createElement('tr');
      var errorCell = cell(message, 'muted');
      errorCell.colSpan = id === 'balances-body' ? 8 : 7;
      row.appendChild(errorCell);
      body.appendChild(row);
    });
    var container = el('findings');
    clear(container);
    var node = document.createElement('p');
    node.className = 'muted';
    node.textContent = message;
    container.appendChild(node);
  }

  function render(report) {
    renderSummary(report);
    renderBalances(report);
    renderPolicy(report);
    renderFindings(report);
    renderLedger(report);
  }

  fetch(ENDPOINT)
    .then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok || !payload.success) {
          var detail = payload && payload.error ? payload.error.message : 'HTTP ' + response.status;
          throw new Error(detail);
        }
        return payload.data;
      });
    })
    .then(render)
    .catch(function (error) {
      renderError('Treasury data unavailable: ' + error.message);
    });
})();
