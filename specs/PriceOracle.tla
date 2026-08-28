----------------------------- MODULE PriceOracle -----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Admins, Sources, Assets, MaxHistoryLen

VARIABLES initialized, admin, authorizedSources, latestPrice, history, balances

Init ==
  /\ initialized = FALSE
  /\ admin = NULL
  /\ authorizedSources = {}
  /\ latestPrice = [a \in Assets |-> NULL]
  /\ history = [a \in Assets |-> <<>>]
  /\ balances = [a \in Admins \cup Sources |-> 0]

Initialize(a) ==
  /\ initialized = FALSE
  /\ a \in Admins
  /\ initialized' = TRUE
  /\ admin' = a
  /\ UNCHANGED <<authorizedSources, latestPrice, history, balances>>

AddSource(caller, source) ==
  /\ initialized = TRUE
  /\ caller = admin
  /\ source \in Sources
  /\ authorizedSources' = authorizedSources \cup {source}
  /\ UNCHANGED <<initialized, admin, latestPrice, history, balances>>

SubmitPrice(source, asset, price, timestamp) ==
  /\ source \in authorizedSources
  /\ asset \in Assets
  /\ price \in Nat
  /\ latestPrice[asset] = NULL \/ timestamp >= latestPrice[asset].timestamp
  /\ latestPrice' = [latestPrice EXCEPT ![asset] = [source |-> source, price |-> price, timestamp |-> timestamp]]
  /\ history' = [history EXCEPT ![asset] =
        IF Len(@) < MaxHistoryLen
        THEN Append(@, latestPrice'[asset])
        ELSE Tail(Append(@, latestPrice'[asset]))]
  /\ UNCHANGED <<initialized, admin, authorizedSources, balances>>

NoOp ==
  UNCHANGED <<initialized, admin, authorizedSources, latestPrice, history, balances>>

Next ==
  \/ \E a \in Admins: Initialize(a)
  \/ \E c \in Admins, s \in Sources: AddSource(c, s)
  \/ \E s \in Sources, a \in Assets, p \in Nat, t \in Nat: SubmitPrice(s, a, p, t)
  \/ NoOp

NoLossOfFunds == balances' = balances
PriceNonNegative == \A a \in Assets: latestPrice[a] = NULL \/ latestPrice[a].price >= 0
AccessControl == \A c \in Admins, s \in Sources: c # admin => ~AddSource(c, s)
WriteOnceInitialization == initialized => admin' = admin
PriceMonotonicity == \A a \in Assets:
  latestPrice[a] = NULL \/ latestPrice'[a] = NULL \/ latestPrice'[a].timestamp >= latestPrice[a].timestamp
BoundedStorage == \A a \in Assets: Len(history[a]) <= MaxHistoryLen

Spec == Init /\ [][Next]_<<initialized, admin, authorizedSources, latestPrice, history, balances>>

=============================================================================
